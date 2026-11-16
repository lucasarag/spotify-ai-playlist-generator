import "server-only";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { APICallError } from "ai";
import { type Candidate, coolDown, describeCandidate } from "./model-catalog";
import { REGISTRY } from "./provider-registry";
import type { ProviderId } from "./providers";
import type { ModelStatus } from "./tool-output";

/**
 * Max time for a model's server to respond at all (stream opened or error status returned).
 * Overloaded models can hold the request open for minutes before answering "busy"; after this
 * long we cancel the request and move to the next model.
 */
const CONNECT_TIMEOUT_MS = 30_000;
/**
 * Once connected, give up on a model that hasn't produced any output after this long.
 * Thought summaries count as output, so a model that is thinking isn't cut off.
 */
const FIRST_CHUNK_TIMEOUT_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 60_000;

/** Parts that mean the model has started answering, so it's too late to switch. */
const CONTENT_PARTS = new Set<LanguageModelV4StreamPart["type"]>([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-call",
  "file",
  "source",
  "finish",
]);

export class AllModelsFailedError extends Error {
  constructor(public readonly attempts: Failure[]) {
    super(`All available models failed: ${attempts.map((a) => `${a.model} (${a.reason})`).join("; ")}`);
    this.name = "AllModelsFailedError";
  }
}

/** Longest pause we'll make before one more pass when every model is only briefly limited. */
const MAX_RETRY_WAIT_MS = 30_000;

export interface Failure {
  model: string;
  provider: ProviderId;
  reason: string;
  /** Provider's own message, for logs. */
  detail: string;
  /** Skip this model on later requests for this long (0 = don't). */
  cooldownMs: number;
  /** Worth retrying after this wait (null = retrying the same request won't help). */
  retryInMs: number | null;
}

/** Suggested wait from Retry-After, Gemini's RetryInfo ("retryDelay": "33s"), or Groq's "try again in 7.5s". */
function suggestedWaitMs(error: InstanceType<typeof APICallError>): number | null {
  const header = Number(error.responseHeaders?.["retry-after"]);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const text = `${error.responseBody ?? ""} ${error.message}`;
  const delay = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) ?? text.match(/try again in (\d+(?:\.\d+)?)s/i);
  return delay ? Math.ceil(Number(delay[1]) * 1000) : null;
}

function providerMessage(error: InstanceType<typeof APICallError>): string {
  try {
    const parsed = JSON.parse(error.responseBody ?? "");
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string") return message.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // not JSON
  }
  return error.message.replace(/\s+/g, " ").slice(0, 200);
}

function classify(error: unknown, candidate: Candidate): Failure {
  const base = { model: describeCandidate(candidate), provider: candidate.provider };
  if (APICallError.isInstance(error)) {
    const text = `${error.message} ${error.responseBody ?? ""}`;
    const detail = providerMessage(error);
    const code = error.statusCode;
    const wait = suggestedWaitMs(error);

    if (code === 413 || /request too large|context length|maximum context|reduce the length/i.test(text)) {
      // Too big for this model / tier: same request will fail again, but smaller ones may fit.
      return { ...base, reason: "request too large", detail, cooldownMs: 0, retryInMs: null };
    }
    if (code === 429 && /PerDay|per day|daily/i.test(text)) {
      return { ...base, reason: "daily free quota used up", detail, cooldownMs: 60 * 60_000, retryInMs: null };
    }
    if (code === 429) {
      return { ...base, reason: "rate limited", detail, cooldownMs: wait ?? DEFAULT_COOLDOWN_MS, retryInMs: wait ?? 20_000 };
    }
    if (code === 503 || code === 500 || code === 502 || code === 504 || /high demand|overloaded|unavailable/i.test(text)) {
      return { ...base, reason: "busy", detail, cooldownMs: 30_000, retryInMs: 10_000 };
    }
    if (code === 404 || /not found|deprecated|decommissioned|not supported/i.test(text)) {
      return { ...base, reason: "unavailable", detail, cooldownMs: 30 * 60_000, retryInMs: null };
    }
    if (code === 401 || code === 403) return { ...base, reason: "key rejected", detail, cooldownMs: 0, retryInMs: null };
    return { ...base, reason: `error ${code ?? ""}`.trim(), detail, cooldownMs: 0, retryInMs: null };
  }
  if (error instanceof Error && error.name === "ConnectTimeout") {
    return { ...base, reason: "not responding", detail: error.message, cooldownMs: DEFAULT_COOLDOWN_MS, retryInMs: 10_000 };
  }
  if (error instanceof Error && error.name === "FirstChunkTimeout") {
    return { ...base, reason: "no response", detail: error.message, cooldownMs: DEFAULT_COOLDOWN_MS, retryInMs: 10_000 };
  }
  const detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
  return { ...base, reason: "error", detail, cooldownMs: 0, retryInMs: null };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** True only when the *user* cancelled (Stop button / closed tab), not when we timed out a model. */
function isUserAbort(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

function connectTimeoutError(): Error {
  return Object.assign(new Error(`Model did not respond within ${CONNECT_TIMEOUT_MS / 1000}s`), { name: "ConnectTimeout" });
}

/**
 * Runs `connect` with a deadline. On timeout the attempt's abort signal fires (cancelling the
 * underlying HTTP request) and the promise rejects right away, even if the provider ignores aborts.
 */
async function withConnectTimeout<T>(userSignal: AbortSignal | undefined, connect: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const attempt = new AbortController();
  const signal = userSignal ? AbortSignal.any([userSignal, attempt.signal]) : attempt.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = connectTimeoutError();
      attempt.abort(error);
      reject(error);
    }, CONNECT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([connect(signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-model speed settings. Reasoning models think silently before every agent step; for a
 * playlist agent a short think is plenty, and it removes most of the wait. Thought summaries
 * are streamed so the UI can show the model is alive.
 */
export type ThinkingMode = "low" | "minimal";

function speedOptions(candidate: Candidate, thinking: ThinkingMode): LanguageModelV4CallOptions["providerOptions"] {
  const id = candidate.modelId;
  if (candidate.provider === "google") {
    const generation = Number(id.match(/^gemini-(\d+)/)?.[1] ?? 0);
    return {
      google: {
        thinkingConfig:
          generation >= 3
            ? { thinkingLevel: thinking, includeThoughts: thinking !== "minimal" }
            : { thinkingBudget: thinking === "minimal" ? 0 : 1024, includeThoughts: thinking !== "minimal" },
      },
    };
  }
  if (/gpt-oss/.test(id)) return { groq: { reasoningEffort: "low", reasoningFormat: "parsed" } };
  return undefined;
}

function withSpeedOptions(options: LanguageModelV4CallOptions, candidate: Candidate, thinking: ThinkingMode): LanguageModelV4CallOptions {
  const extra = speedOptions(candidate, thinking);
  if (!extra) return options;
  const merged = { ...options.providerOptions };
  for (const [provider, values] of Object.entries(extra)) merged[provider] = { ...values, ...merged[provider] };
  return { ...options, providerOptions: merged };
}

function instantiate(provider: ProviderId, modelId: string, apiKey: string): LanguageModelV4 {
  return REGISTRY[provider].create(modelId, apiKey);
}

/** Rough token estimate (≈4 chars per token) of everything sent with a request. */
function estimatePromptTokens(options: LanguageModelV4CallOptions): number {
  return Math.ceil((JSON.stringify(options.prompt).length + JSON.stringify(options.tools ?? []).length) / 4);
}

const MIN_OUTPUT_TOKENS = 800;

/**
 * Free tiers like Groq and Cerebras count prompt + max_tokens against their limit, and an unset
 * max_tokens can default to the model's maximum, so requests get rejected as "too large" before
 * any text is written. Cap the requested output to what's left of the provider's budget.
 */
function withTokenBudget(options: LanguageModelV4CallOptions, candidate: Candidate, override?: number): LanguageModelV4CallOptions {
  const budget = REGISTRY[candidate.provider].tokenBudget;
  if (!budget && override === undefined) return options;
  const room = budget ? budget - estimatePromptTokens(options) : Infinity;
  const cap = Math.max(MIN_OUTPUT_TOKENS, Math.min(override ?? Infinity, room, options.maxOutputTokens ?? Infinity));
  return Number.isFinite(cap) ? { ...options, maxOutputTokens: Math.floor(cap) } : options;
}

/** Groq-style "Limit 8000, Requested 9412": how many tokens the request must shed. */
function tokensOverLimit(failure: Failure): number | null {
  const m = failure.detail.match(/Limit\s*:?\s*(\d+)[^\d]+Requested\s*:?\s*(\d+)/i);
  return m ? Number(m[2]) - Number(m[1]) : null;
}

/**
 * Waits for the first content-bearing part. Errors (e.g. "high demand") or silence before
 * that point throw, so the caller can fall back. Buffered parts are replayed afterwards.
 */
async function guardFirstChunk(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<ReadableStream<LanguageModelV4StreamPart>> {
  const reader = stream.getReader();
  const buffered: LanguageModelV4StreamPart[] = [];
  const deadline = Date.now() + FIRST_CHUNK_TIMEOUT_MS;

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("No response from model"), { name: "FirstChunkTimeout" })),
        Math.max(0, deadline - Date.now()),
      );
    });
    let result: ReadableStreamReadResult<LanguageModelV4StreamPart>;
    try {
      result = await Promise.race([reader.read(), timeout]);
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (result.done) break;
    const part = result.value;
    if (part.type === "error") {
      reader.cancel().catch(() => {});
      throw part.error;
    }
    buffered.push(part);
    if (CONTENT_PARTS.has(part.type)) break;
  }

  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * A language model that tries a chain of candidates in order. When one is busy, rate-limited,
 * retired or too small for the request, it moves on to the next and remembers the one that
 * worked for the remaining steps of the agent loop.
 */
export class FallbackModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "fallback";
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly models: { candidate: Candidate; model: LanguageModelV4 }[];
  private active = 0;
  /** Human-readable log of switches, surfaced in the UI. */
  readonly switches: string[] = [];
  /** Live progress hook (connecting / busy / working), used to stream status to the UI. */
  onStatus?: (status: ModelStatus) => void;

  /** "low" for the tool-calling agent; "minimal" for one-shot list generation (fastest). */
  private readonly thinking: ThinkingMode;

  constructor(candidates: Candidate[], keys: Partial<Record<ProviderId, string>>, options: { thinking?: ThinkingMode } = {}) {
    this.thinking = options.thinking ?? "low";
    if (!candidates.length) throw new Error("No models available for the saved API keys.");
    this.models = candidates.map((candidate) => ({
      candidate,
      model: instantiate(candidate.provider, candidate.modelId, keys[candidate.provider]!.trim()),
    }));
  }

  get modelId(): string {
    return this.models[this.active].candidate.modelId;
  }

  get activeCandidate(): Candidate {
    return this.models[this.active].candidate;
  }

  get activeLabel(): string {
    return describeCandidate(this.models[this.active].candidate);
  }

  doGenerate(options: LanguageModelV4CallOptions) {
    return this.run(options, (m, c, cap) => m.doGenerate(withTokenBudget(withSpeedOptions(options, c, this.thinking), c, cap)));
  }

  doStream(options: LanguageModelV4CallOptions) {
    return this.run(options, async (m, c, cap) => {
      // Phase 1: reach the model (≤ 10s). Phase 2: first output (≤ 30s, inside guardFirstChunk).
      const result = await withConnectTimeout(options.abortSignal, (abortSignal) =>
        m.doStream({ ...withTokenBudget(withSpeedOptions(options, c, this.thinking), c, cap), abortSignal }),
      );
      return { ...result, stream: await guardFirstChunk(result.stream) };
    });
  }

  private async run<T>(
    options: LanguageModelV4CallOptions,
    call: (model: LanguageModelV4, candidate: Candidate, maxOutputCap?: number) => PromiseLike<T>,
  ): Promise<T> {
    const failures: Failure[] = [];
    let lastError: unknown;
    // Pass 1: every model, starting from the one that last worked. Pass 2 (at most once): after a
    // short wait, only the models that were briefly limited (busy / per-minute rate limit).
    let order = this.models.map((_, n) => (this.active + n) % this.models.length);

    for (let pass = 1; pass <= 2; pass++) {
      const passFailures: (Failure & { index: number })[] = [];

      for (const i of order) {
        const { candidate, model } = this.models[i];
        const label = describeCandidate(candidate);
        // Output cap for this model; lowered once if the provider says the request is over its limit.
        let cap: number | undefined;

        for (let attempt = 1; attempt <= 2; attempt++) {
          const started = Date.now();
          this.onStatus?.({ phase: "connecting", model: label });
          try {
            const result = await call(model, candidate, cap);
            const firstChunkMs = Date.now() - started;
            console.info(`[model] ${label}: responding after ${(firstChunkMs / 1000).toFixed(1)}s`);
            this.onStatus?.({ phase: "working", model: label, firstChunkMs });
            if (i !== this.active || failures.length || passFailures.length) {
              const first = failures[0] ?? passFailures[0];
              if (first) this.switches.push(`${first.model} was ${first.reason}, switched to ${label}`);
              this.active = i;
            }
            return result;
          } catch (error) {
            if (isUserAbort(options.abortSignal)) throw error;
            const failure = classify(error, candidate);
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            console.warn(`[model] ${label}: ${failure.reason} after ${elapsed}s — ${failure.detail}`);

            // "Limit 8000, Requested 9412": retry this model right away asking for less output.
            const over = failure.reason === "request too large" ? tokensOverLimit(failure) : null;
            const used = withTokenBudget(withSpeedOptions(options, candidate, this.thinking), candidate, cap).maxOutputTokens;
            if (attempt === 1 && over !== null && used !== undefined && used - over - 200 >= MIN_OUTPUT_TOKENS) {
              cap = used - over - 200;
              console.info(`[model] ${label}: retrying with max output ${cap} tokens to fit the limit`);
              continue;
            }

            this.onStatus?.({ phase: "busy", model: label, reason: failure.reason });
            if (failure.cooldownMs > 0) coolDown(candidate, failure.cooldownMs);
            passFailures.push({ ...failure, index: i });
            lastError = error;
            break;
          }
        }
      }

      failures.push(...passFailures);
      const retryable = passFailures.filter((f) => f.retryInMs !== null && f.retryInMs <= MAX_RETRY_WAIT_MS);
      if (pass === 2 || !retryable.length) break;

      const waitMs = Math.max(2_000, Math.min(...retryable.map((f) => f.retryInMs!)));
      console.info(`[model] every model is briefly limited; retrying ${retryable.length} of them in ${(waitMs / 1000).toFixed(0)}s`);
      this.onStatus?.({ phase: "waiting", seconds: Math.round(waitMs / 1000) });
      await sleep(waitMs, options.abortSignal);
      order = retryable.map((f) => f.index);
    }

    if (failures.length === 1) throw lastError;
    throw new AllModelsFailedError(failures);
  }
}
