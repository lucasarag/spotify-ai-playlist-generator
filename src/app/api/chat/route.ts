import {
  type UIMessage,
  APICallError,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import { AllModelsFailedError, FallbackModel } from "@/lib/ai/fallback-model";
import { resolveCandidates } from "@/lib/ai/model-catalog";
import { PROVIDERS, type ProviderId, isProviderId } from "@/lib/ai/providers";
import type { ChatDataParts, ChatMetadata } from "@/lib/ai/tool-output";
import { collectionsFromHistory, createSpotifyTools } from "@/lib/ai/tools";
import { runQuickPlaylist } from "@/lib/quick/quick-playlist";
import { SpotifyApiError } from "@/lib/spotify/http";

// Large playlist jobs make hundreds of Spotify calls; give them room.
export const maxDuration = 300;

function instructions() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a playlist agent with direct access to the user's Spotify account through tools. Today is ${today}.

Language:
- Users write in Portuguese (including Brazilian Portuguese and informal or misspelled text), English, or other languages. Understand any of them.
- Always reply in the language of the user's latest message. Name and describe new playlists in that language too, unless the user gives a name.
- Never translate song titles, album names or artist names in search queries: use their original titles (e.g. "track:Garota de Ipanema artist:Tom Jobim", "track:Gurenge artist:LiSA").
- Interpret common Portuguese terms: "músicas" = tracks, "faixas" = tracks, "lançamentos" = new releases, "abertura/encerramento" = opening/ending (OP/ED), "remover/tirar" = remove, "adicionar/colocar" = add, "que eu não escuto" = underplayed.

How to work:
- Act, don't describe. Use tools to gather what you need, then make the change. Never invent track URIs or playlist IDs; only use values returned by tools.
- Finding a playlist by name: call getUserPlaylists (use nameContains) and pick the matching id. Ask only if several plausible matches remain.
- Building a playlist of N songs:
  1. Draft about 20% more specific songs than requested (real songs you are confident exist), then call searchTracks with one query per song, e.g. "track:Gurenge artist:LiSA", resultsPerQuery 1. Send up to 250 queries per call; split larger jobs across calls.
  2. If you are short after dedup and misses, run another searchTracks round with new songs.
  3. Call createPlaylist with the collectionIds from those searches and maxTracks N. Do not re-list URIs you can reference by collectionId.
- collectionIds stay valid for the whole conversation. Tool results show tracks by 22-char track ID; pass those IDs directly (trackUris / removeUris accept them).
- Personalising: getUserListeningStats gives top artists/tracks (short/medium/long term) and recent plays. getArtistsLatestReleases takes artist IDs from it and returns new releases with a collectionId.
- Pruning: call getUserListeningStats with analyzePlaylistId. Spotify has no play or skip counts, so "underplayed" is an inference; say so briefly.
- Removing tracks from an existing playlist can't be undone from this app. Before removing, show the user which tracks (name — artist) will go and wait for confirmation, unless the user already told you to go ahead without asking. Creating new playlists and adding tracks needs no confirmation.
- Only playlists the user owns or collaborates on can be read track-by-track or edited.

Replying:
- The UI already shows tool progress and a playlist preview card with a Spotify link, so keep the final reply short: what you did, notable gaps (e.g. songs that weren't found), and a next-step suggestion if useful.
- Use Markdown sparingly.`;
}

const SPOTIFY_EXPIRED = "Your Spotify connection expired. Reconnect Spotify to continue.";

function describeError(error: unknown): string {
  if (error instanceof SpotifyApiError) {
    if (error.status === 401) return SPOTIFY_EXPIRED;
    if (error.status === 403) return `Spotify refused the request: ${error.message}`;
    return error.message;
  }
  if (error instanceof AllModelsFailedError) {
    const reasons = new Set(error.attempts.map((a) => a.reason));
    if ([...reasons].every((r) => r === "key rejected")) return "Your AI API keys were rejected. Check them in Settings.";

    // One sentence per provider, e.g. "Gemini: busy, daily free quota used up. Groq: request too large."
    const byProvider = new Map<ProviderId, Set<string>>();
    for (const a of error.attempts) byProvider.set(a.provider, (byProvider.get(a.provider) ?? new Set()).add(a.reason));
    const summary = [...byProvider].map(([p, r]) => `${PROVIDERS[p].label}: ${[...r].join(", ")}`).join(". ");

    const tips: string[] = [];
    if (reasons.has("request too large")) {
      tips.push("This conversation is too long for some free-tier models; starting a new chat makes requests smaller");
    }
    if (reasons.has("daily free quota used up")) tips.push("daily quotas reset within 24 hours");
    if ([...reasons].some((r) => ["busy", "rate limited", "not responding", "no response"].includes(r))) {
      tips.push("busy models usually free up within a minute or two");
    }
    if (byProvider.size === 1) tips.push("adding a key for the other provider in Settings gives the agent more models to fall back on");
    return `No AI model could take this request (${summary}). ${tips.join("; ")}.`.replace(/^(.)/, (c) => c.toUpperCase());
  }
  if (APICallError.isInstance(error)) {
    const code = error.statusCode;
    if (code === 401 || code === 403 || (code === 400 && /api[ _-]?key/i.test(error.message))) {
      return "Your AI API key was rejected. Check it in Settings.";
    }
    if (code === 429 || code === 503) {
      return "The AI model is busy or rate-limited right now. Wait a minute and try again, or add a key for another provider in Settings.";
    }
    return `AI model error (${code ?? "unknown"}): ${error.message}`;
  }
  return error instanceof Error ? error.message : "Something went wrong while generating the response.";
}

/**
 * Stateless: the browser sends the user's own Spotify access token and AI keys with
 * every request. Neither is stored or logged on the server.
 */
interface ChatRequest {
  messages: UIMessage[];
  keys?: Partial<Record<string, string>>;
  spotifyToken?: string;
  /** The model that answered the previous request in this browser. */
  preferredModel?: { provider?: string; modelId?: string } | null;
  /** "quick" (default): one LLM call makes a song list. "agent": tool-calling agent for edits/analysis. */
  mode?: "quick" | "agent";
}

export async function POST(req: Request) {
  const { messages, keys: rawKeys, spotifyToken, preferredModel, mode }: ChatRequest = await req.json();

  if (!spotifyToken) return Response.json({ error: SPOTIFY_EXPIRED }, { status: 401 });

  const keys: Partial<Record<ProviderId, string>> = {};
  for (const [provider, key] of Object.entries(rawKeys ?? {})) {
    if (isProviderId(provider) && key?.trim()) keys[provider] = key.trim();
  }
  if (!Object.keys(keys).length) {
    return Response.json({ error: "Add an AI provider key (Gemini, Groq, Cerebras, Mistral or OpenRouter) in Settings to continue." }, { status: 400 });
  }

  const preferred =
    isProviderId(preferredModel?.provider) && typeof preferredModel.modelId === "string"
      ? { provider: preferredModel.provider, modelId: preferredModel.modelId }
      : null;
  const { candidates, rejectedKeys } = await resolveCandidates(keys, preferred);
  const rejectedLabels = rejectedKeys.map((p) => PROVIDERS[p].label);
  if (!candidates.length) {
    return Response.json(
      { error: `${rejectedLabels.join(" and ")} rejected your API key. Check it in Settings.` },
      { status: 400 },
    );
  }

  const metadata = (model: FallbackModel): ChatMetadata => ({
    model: model.activeLabel,
    modelRef: { ...model.activeCandidate },
    switches: model.switches.length ? [...model.switches] : undefined,
    warnings: rejectedLabels.length ? [`${rejectedLabels.join(" and ")} key was rejected, so it was skipped.`] : undefined,
  });

  // ---------- Quick playlist (default): 1 plain-text LLM call, Spotify work done by the server ----------
  if (mode !== "agent") {
    const model = new FallbackModel(candidates, keys, { thinking: "minimal" });
    const userTexts = messages
      .filter((m) => m.role === "user")
      .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim())
      .filter(Boolean);
    const started = Date.now();
    console.info(`[quick] new request · first model: ${model.activeLabel}`);

    const stream = createUIMessageStream<UIMessage<ChatMetadata, ChatDataParts>>({
      onError: describeError,
      execute: async ({ writer }) => {
        model.onStatus = (status) => writer.write({ type: "data-status", data: status, transient: true });
        writer.write({ type: "start" });
        await runQuickPlaylist({
          writer,
          model,
          token: spotifyToken,
          request: userTexts.at(-1) ?? "",
          earlierRequests: userTexts.slice(-4, -1),
          signal: req.signal,
        });
        writer.write({ type: "finish", messageMetadata: metadata(model) });
        console.info(`[quick] finished in ${((Date.now() - started) / 1000).toFixed(1)}s · ${model.activeLabel}`);
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // ---------- Agent mode: tool-calling loop for editing / analyzing existing playlists ----------
  const model = new FallbackModel(candidates, keys);
  // Quick-mode steps that aren't real agent tools are left out of the agent's history.
  const agentHistory = messages.map((m) => ({
    ...m,
    parts: m.parts.filter((p) => p.type !== "tool-generateSongList"),
  }));
  // Same tool set for history conversion and the run: earlier tool results are re-sent in their
  // compact form, and collections from earlier turns stay usable.
  const tools = createSpotifyTools(spotifyToken, collectionsFromHistory(agentHistory));
  const modelMessages = await convertToModelMessages(agentHistory, { tools });
  const requestStarted = Date.now();
  let stepStarted = requestStarted;
  let stepNumber = 0;
  const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
  const reusing =
    preferred && candidates[0].provider === preferred.provider && candidates[0].modelId === preferred.modelId;
  console.info(
    `[agent] new request · ${candidates.length} candidate models · first: ${model.activeLabel}${reusing ? " (last model that answered)" : ""}`,
  );

  const stream = createUIMessageStream<UIMessage<ChatMetadata, ChatDataParts>>({
    onError: describeError,
    execute: ({ writer }) => {
      // Live "connecting / busy / working" updates; transient, so they don't pile up in history.
      model.onStatus = (status) => writer.write({ type: "data-status", data: status, transient: true });

      const result = streamText({
        model,
        instructions: instructions(),
        messages: modelMessages,
        tools,
        stopWhen: isStepCount(30),
        // FallbackModel already moves through every candidate; one extra pass covers short blips.
        maxRetries: 1,
        abortSignal: req.signal,
        onStepEnd: (step) => {
          const tools = step.toolCalls.map((t) => t.toolName).join(", ");
          console.info(`[agent] step ${++stepNumber} done in ${seconds(stepStarted)} · ${tools ? `tools: ${tools}` : "final answer"}`);
          stepStarted = Date.now();
        },
        onEnd: () => console.info(`[agent] finished in ${seconds(requestStarted)} · ${model.activeLabel}`),
      });

      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          onError: describeError,
          messageMetadata: ({ part }): ChatMetadata | undefined => (part.type === "finish" ? metadata(model) : undefined),
        }),
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
