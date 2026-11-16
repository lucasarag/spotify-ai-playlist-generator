import "server-only";
import { type UIMessageStreamWriter, streamText } from "ai";
import type { FallbackModel } from "@/lib/ai/fallback-model";
import { buildPlaylistCard } from "@/lib/ai/tools";
import {
  type CompactTrack,
  type SpotifyTrack,
  addTracksToPlaylist,
  compactTrack,
  createPlaylist,
  dedupeKey,
  searchTracks,
} from "@/lib/spotify/api";

/**
 * "Quick playlist": the free-tier-friendly path.
 *
 *   1 LLM call, no tools  →  plain text: name + "Title | Artist" lines
 *   server (no LLM)       →  Spotify search per line (starts while the list is still streaming),
 *                            dedupe, create playlist, add tracks in batches of 100
 *   at most 1 more call   →  only if too many suggestions weren't on Spotify
 *
 * Compared with the tool-calling agent this sends 1–2 small requests instead of 5–10 large ones,
 * so it fits free rate limits and token-per-minute caps.
 *
 * Progress is written to the chat stream as the same tool-style steps the agent uses, so the UI
 * renders it identically (live step log + playlist card).
 */

const DEFAULT_COUNT = 30;
const MAX_COUNT = 500;
const SEARCH_CONCURRENCY = 4;

function instructions(): string {
  return `You turn a playlist request into a list of real songs that exist on Spotify.
Reply with plain text only, in exactly this format (no Markdown, no numbering, no commentary):

LANG: <ISO 639-1 code of the user's language, e.g. pt or en>
NAME: <short playlist name, in the user's language>
DESCRIPTION: <one short sentence, in the user's language>
COUNT: <how many songs the user asked for; ${DEFAULT_COUNT} if they didn't say; at most ${MAX_COUNT}>
SONGS:
<song title> | <main artist>
<song title> | <main artist>

Rules:
- List about 20% more songs than COUNT, because some won't be found on Spotify.
- Only real, released songs. Keep original titles and artist names exactly as credited (never translate them).
- No duplicates. Follow the user's theme, era, genre, mood, language and any artists to include or avoid.
- The user may write in Portuguese, English or any other language.`;
}

interface Suggestion {
  title: string;
  artist: string;
}

interface Header {
  lang: string;
  name: string;
  description: string;
  count: number;
}

const HEADER_LINE = /^\s*(LANG|NAME|DESCRIPTION|COUNT)\s*:\s*(.*)$/i;

/** "Title | Artist" (also tolerates "Title - Artist", bullets and numbering). */
function parseSongLine(line: string): Suggestion | null {
  const cleaned = line
    .replace(/^\s*(?:\d+[.)]\s*|[-*•]\s+)/, "")
    .replace(/\*\*/g, "")
    .trim();
  if (!cleaned || /^songs\s*:?$/i.test(cleaned) || HEADER_LINE.test(cleaned)) return null;
  const [title, artist] = cleaned.includes("|")
    ? cleaned.split("|").map((s) => s.trim())
    : cleaned.split(/\s+[–—-]\s+/).map((s) => s.trim());
  if (!title) return null;
  return { title: title.replace(/^["“]|["”]$/g, ""), artist: artist ?? "" };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s*[(\[].*?[)\]]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** How well a Spotify result matches the suggestion (title similarity + artist match). */
function score(track: SpotifyTrack, s: Suggestion): number {
  const title = normalize(s.title);
  const name = normalize(track.name);
  const artist = normalize(s.artist);
  let points = 0;
  if (name === title) points += 3;
  else if (name.startsWith(title) || title.startsWith(name)) points += 2;
  else if (name.includes(title) || title.includes(name)) points += 1;
  if (artist && (track.artists ?? []).some((a) => normalize(a.name).includes(artist) || artist.includes(normalize(a.name)))) {
    points += 3;
  }
  return points;
}

/** Best Spotify match for one suggestion: plain-text query first, field filters as fallback. */
async function findOnSpotify(token: string, s: Suggestion, signal?: AbortSignal): Promise<SpotifyTrack | null> {
  const attempts = [
    `${s.title} ${s.artist}`.trim(),
    s.artist ? `track:"${s.title}" artist:"${s.artist}"` : `track:"${s.title}"`,
  ];
  let best: { track: SpotifyTrack; points: number } | null = null;
  for (const query of attempts) {
    const results = await searchTracks(token, query, { limit: 5, signal });
    for (const track of results) {
      const points = score(track, s);
      if (!best || points > best.points) best = { track, points };
    }
    if (best && best.points >= 5) break; // title + artist matched
  }
  // Require at least a partial title match, or an artist match plus some title overlap.
  return best && best.points >= 2 ? best.track : null;
}

/** Tiny promise pool: runs at most `limit` tasks at once, in submission order. */
function createPool(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    queue.shift()!();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() =>
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          }),
      );
      next();
    });
}

// ---------- Stream helpers: tool-style steps rendered by the existing chat UI ----------

type Writer = UIMessageStreamWriter;

function stepWriter(writer: Writer, toolName: string, input: unknown) {
  const toolCallId = `quick-${toolName}-${Date.now().toString(36)}`;
  writer.write({ type: "tool-input-available", toolCallId, toolName, input });
  return {
    progress: (message: string) =>
      writer.write({ type: "tool-output-available", toolCallId, output: { status: "running", message }, preliminary: true }),
    done: (output: Record<string, unknown>) =>
      writer.write({ type: "tool-output-available", toolCallId, output: { status: "done", ...output } }),
    fail: (errorText: string) => writer.write({ type: "tool-output-error", toolCallId, errorText }),
  };
}

function writeText(writer: Writer, text: string) {
  const id = `quick-text-${Date.now().toString(36)}`;
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
}

// ---------- Pipeline ----------

/**
 * Streams one LLM response as lines, calling `onSong` for each parsed suggestion as soon as its
 * line is complete (so Spotify searches overlap with generation).
 */
async function generateSuggestions(
  model: FallbackModel,
  prompt: string,
  onHeader: (h: Partial<Header>) => void,
  onSong: (s: Suggestion) => void,
  signal?: AbortSignal,
) {
  const result = streamText({
    model,
    instructions: instructions(),
    prompt,
    maxRetries: 1,
    maxOutputTokens: 12_000,
    abortSignal: signal,
  });

  let buffer = "";
  const handleLine = (line: string) => {
    const header = line.match(HEADER_LINE);
    if (header) {
      const [, key, value] = header;
      const k = key.toLowerCase();
      if (k === "count") onHeader({ count: Math.min(MAX_COUNT, Math.max(1, parseInt(value, 10) || DEFAULT_COUNT)) });
      else onHeader({ [k]: value.trim() } as Partial<Header>);
      return;
    }
    const song = parseSongLine(line);
    if (song) onSong(song);
  };

  for await (const part of result.stream) {
    if (part.type === "error") throw part.error;
    if (part.type !== "text-delta") continue;
    buffer += part.text;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer);
}

export async function runQuickPlaylist({
  writer,
  model,
  token,
  request,
  earlierRequests,
  signal,
}: {
  writer: Writer;
  model: FallbackModel;
  token: string;
  /** The user's latest message. */
  request: string;
  /** Earlier user messages in this chat, for follow-ups like "make it more upbeat". */
  earlierRequests: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const header: Header = { lang: "en", name: "", description: "", count: DEFAULT_COUNT };
  const seenKeys = new Set<string>();
  const seenUris = new Set<string>();
  const found: { order: number; track: SpotifyTrack }[] = [];
  const tried: Suggestion[] = [];
  const notFound: string[] = [];
  const pool = createPool(SEARCH_CONCURRENCY);
  const searches: Promise<void>[] = [];
  let order = 0;

  const ideas = stepWriter(writer, "generateSongList", { request });
  const search = stepWriter(writer, "searchTracks", { queries: ["(generated song list)"] });
  ideas.progress("Asking the AI for song ideas…");
  search.progress("Waiting for the first songs…");

  let searched = 0;
  const queueSearch = (s: Suggestion) => {
    const key = `${normalize(s.title)}::${normalize(s.artist)}`;
    if (tried.some((t) => `${normalize(t.title)}::${normalize(t.artist)}` === key)) return;
    tried.push(s);
    const position = order++;
    searches.push(
      pool(async () => {
        const track = await findOnSpotify(token, s, signal).catch((err) => {
          if (signal?.aborted) throw err;
          return null; // one failed search shouldn't sink the playlist
        });
        searched++;
        if (!track) notFound.push(s.artist ? `${s.title} — ${s.artist}` : s.title);
        else {
          const k = dedupeKey(track);
          if (!seenUris.has(track.uri) && !seenKeys.has(k)) {
            seenUris.add(track.uri);
            seenKeys.add(k);
            found.push({ order: position, track });
          }
        }
        search.progress(`Searched ${searched} of ${tried.length} songs on Spotify · ${found.length} found…`);
      }),
    );
  };

  const prompt = [
    earlierRequests.length ? `Earlier requests in this chat (for context):\n${earlierRequests.map((r) => `- ${r}`).join("\n")}\n` : "",
    `Request: ${request}`,
  ].join("\n");

  // Round 1: stream the list; searches start as each line arrives.
  try {
    await generateSuggestions(
      model,
      prompt,
      (h) => Object.assign(header, h),
      (s) => {
        queueSearch(s);
        if (tried.length % 10 === 0) ideas.progress(`Got ${tried.length} song ideas from ${model.activeLabel}…`);
      },
      signal,
    );
  } catch (err) {
    ideas.fail(err instanceof Error ? err.message : "The AI couldn't generate a song list.");
    search.fail("Skipped: no song list.");
    throw err;
  }
  if (!tried.length) {
    ideas.fail("The AI reply didn't contain any songs.");
    search.fail("Skipped: no song list.");
    throw new Error("The AI didn't return any songs. Try rephrasing the request.");
  }
  ideas.done({ message: `Got ${tried.length} song ideas from ${model.activeLabel}`, name: header.name, count: header.count });
  await Promise.all(searches);

  // Round 2 (once): ask for replacements if too many suggestions weren't on Spotify.
  const missing = header.count - found.length;
  if (missing > 0) {
    const more = stepWriter(writer, "generateSongList", { request, replacements: missing });
    more.progress(`${found.length} of ${header.count} found. Asking for ${missing} more…`);
    const avoid = tried.map((s) => `${s.title} | ${s.artist}`).join("\n");
    const before = tried.length;
    try {
      await generateSuggestions(
        model,
        `${prompt}\n\nYou already suggested these songs; do NOT repeat any of them:\n${avoid}\n\n` +
          `Use the same format. COUNT stays ${header.count}. List about ${Math.ceil(missing * 1.5)} NEW songs.`,
        () => {},
        queueSearch,
        signal,
      );
      more.done({ message: `Got ${tried.length - before} more song ideas` });
    } catch (err) {
      if (signal?.aborted) throw err;
      more.fail("Couldn't get more ideas; continuing with what was found.");
    }
    await Promise.all(searches);
  }

  found.sort((a, b) => a.order - b.order);
  const tracks: CompactTrack[] = found.slice(0, header.count).map((f) => compactTrack(f.track));
  const collectionUris = tracks.map((t) => t.uri);
  search.done({
    message: `Found ${found.length} songs on Spotify${notFound.length ? ` · ${notFound.length} not found` : ""}`,
    collectionId: `c${Date.now() % 1e8}`,
    collectionUris,
    totalFound: tracks.length,
    notFound,
    tracks,
  });
  if (!tracks.length) throw new Error("None of the suggested songs were found on Spotify. Try a different request.");

  // Create + fill the playlist (no LLM involved).
  const name = header.name || request.slice(0, 60);
  const create = stepWriter(writer, "createPlaylist", { name, description: header.description, maxTracks: header.count });
  create.progress(`Creating “${name}”…`);
  const playlist = await createPlaylist(token, { name, description: header.description, isPublic: false }, signal);
  await addTracksToPlaylist(token, playlist.id, collectionUris, {
    signal,
    onChunk: (done, total) => create.progress(`Added ${done} of ${total} songs…`),
  });
  const card = await buildPlaylistCard(token, playlist.id, { added: collectionUris.length, removed: 0 }, signal);
  create.done({ message: `Created “${card.name}” with ${collectionUris.length} tracks`, playlist: card });

  // Short summary, no extra LLM call.
  const pt = header.lang.toLowerCase().startsWith("pt");
  const lines = [
    pt
      ? `Criei **${card.name}** com ${tracks.length} músicas.`
      : `Created **${card.name}** with ${tracks.length} songs.`,
  ];
  if (tracks.length < header.count) {
    lines.push(
      pt
        ? `Encontrei ${tracks.length} das ${header.count} pedidas no Spotify.`
        : `I found ${tracks.length} of the ${header.count} you asked for on Spotify.`,
    );
  }
  if (notFound.length) {
    const sample = notFound.slice(0, 5).join("; ");
    lines.push(
      pt
        ? `${notFound.length} sugestões não estavam no Spotify (ex.: ${sample}).`
        : `${notFound.length} suggestions weren't on Spotify (e.g. ${sample}).`,
    );
  }
  writeText(writer, lines.join(" "));
}
