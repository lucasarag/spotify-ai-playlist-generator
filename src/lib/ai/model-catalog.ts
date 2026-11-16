import "server-only";
import { createHash } from "node:crypto";
import { REGISTRY } from "./provider-registry";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "./providers";

/**
 * Picks the best available models automatically from whichever provider keys the user saved.
 *
 * Each key's model list is fetched from the provider (so new, deprecated or region-limited
 * models are handled without code changes), ranked by quality and speed for tool-calling
 * agents, and cached. Static lists are used when discovery fails.
 */

export interface Candidate {
  provider: ProviderId;
  modelId: string;
}

const MAX_PER_PROVIDER = 3;
const CACHE_TTL_MS = 30 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Gemini: Flash-class models only (fast, free-tier eligible, strong tool use).
 * Newer versions first; full Flash before Flash-Lite of the same version; stable before preview.
 */
function rankGemini(ids: string[]): string[] {
  return ids
    .flatMap((id) => {
      const m = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview)?(-[\w-]+)?$/);
      if (!m || /tts|image|audio|live|thinking|exp/i.test(id)) return [];
      const version = Number(m[1]);
      const score = version * 10 + (m[2] ? 0 : 5) - (m[3] || m[4] ? 1 : 0);
      return [{ id, score }];
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);
}

/** Other providers: first pattern wins; within a pattern, newest-looking IDs first. */
function rankByPreference(ids: string[], preference: RegExp[]): string[] {
  const out: string[] = [];
  for (const pattern of preference) {
    for (const id of ids.filter((x) => pattern.test(x)).sort().reverse()) if (!out.includes(id)) out.push(id);
  }
  return out;
}

function rank(provider: ProviderId, ids: string[]): string[] {
  return provider === "google" ? rankGemini(ids) : rankByPreference(ids, REGISTRY[provider].preference);
}

type Discovery = { ok: true; ids: string[] } | { ok: false; invalidKey: boolean };

const discoveryCache = new Map<string, { at: number; result: Discovery }>();

async function listModels(provider: ProviderId, apiKey: string): Promise<Discovery> {
  const cacheKey = `${provider}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 24)}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let result: Discovery;
  try {
    const res = await fetch(REGISTRY[provider].modelsUrl, {
      headers: provider === "google" ? { "x-goog-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      result = { ok: false, invalidKey: true };
    } else if (!res.ok) {
      result = { ok: false, invalidKey: false };
    } else {
      const data = await res.json();
      const ids: string[] =
        provider === "google"
          ? (data.models ?? [])
              .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
              .map((m: { name: string }) => m.name.replace(/^models\//, ""))
          : (data.data ?? []).filter((m: { active?: boolean }) => m.active !== false).map((m: { id: string }) => m.id);
      result = { ok: true, ids };
    }
  } catch {
    result = { ok: false, invalidKey: false };
  }

  // Don't cache transient failures.
  if (result.ok || result.invalidKey) discoveryCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

// ---------- Cooldown: skip models that just reported overload / rate limits ----------

const cooldownUntil = new Map<string, number>();
const cooldownKey = (c: Candidate) => `${c.provider}:${c.modelId}`;

export function coolDown(candidate: Candidate, ms: number): void {
  cooldownUntil.set(cooldownKey(candidate), Date.now() + ms);
}

function isCoolingDown(candidate: Candidate): boolean {
  return (cooldownUntil.get(cooldownKey(candidate)) ?? 0) > Date.now();
}

export interface ResolvedModels {
  candidates: Candidate[];
  rejectedKeys: ProviderId[];
}

/**
 * Ordered fallback chain across all providers the user has keys for.
 * Providers are interleaved (best Gemini, best Groq, second Gemini…) so a provider-wide
 * outage costs a single attempt before switching. Models in cooldown go last.
 */
export async function resolveCandidates(
  keys: Partial<Record<ProviderId, string>>,
  preferred?: Candidate | null,
): Promise<ResolvedModels> {
  const providers = PROVIDER_IDS.filter((p) => keys[p]?.trim());
  const rejectedKeys: ProviderId[] = [];

  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      const discovery = await listModels(provider, keys[provider]!.trim());
      if (!discovery.ok && discovery.invalidKey) {
        rejectedKeys.push(provider);
        return [];
      }
      const ranked = discovery.ok ? rank(provider, discovery.ids) : [];
      const ids = (ranked.length ? ranked : REGISTRY[provider].staticModels).slice(0, MAX_PER_PROVIDER);
      return ids.map((modelId) => ({ provider, modelId }));
    }),
  );

  const interleaved: Candidate[] = [];
  for (let i = 0; i < MAX_PER_PROVIDER; i++) {
    for (const list of perProvider) if (list[i]) interleaved.push(list[i]);
  }
  // The model that answered last time goes first, as long as it's still offered for these
  // keys and hasn't reported being busy since.
  const preferredIndex = preferred
    ? interleaved.findIndex((c) => c.provider === preferred.provider && c.modelId === preferred.modelId)
    : -1;
  if (preferredIndex > 0) interleaved.unshift(...interleaved.splice(preferredIndex, 1));

  const ready = interleaved.filter((c) => !isCoolingDown(c));
  const cooling = interleaved.filter((c) => isCoolingDown(c));
  return { candidates: [...ready, ...cooling], rejectedKeys };
}

export function describeCandidate(c: Candidate): string {
  return `${PROVIDERS[c.provider].label} · ${c.modelId}`;
}
