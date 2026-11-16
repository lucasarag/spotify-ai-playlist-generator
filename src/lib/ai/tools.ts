import "server-only";
import { tool } from "ai";
import { z } from "zod";
import {
  type CompactTrack,
  type PlaylistDetails,
  type TimeRange,
  addTracksToPlaylist,
  compactTrack,
  createPlaylist,
  dedupeKey,
  getAlbumTracks,
  getArtistReleasesSince,
  getPlaylistTracks,
  getRecentlyPlayed,
  getTopArtists,
  getTopTracks,
  getUserPlaylists,
  parsePlaylistId,
  playlistUrl,
  removeTracksFromPlaylist,
  searchTracks,
} from "@/lib/spotify/api";
import { mapLimit } from "@/lib/spotify/http";
import type { PlaylistCardData, ToolProgress } from "./tool-output";

const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
const ALL_RANGES: TimeRange[] = ["short_term", "medium_term", "long_term"];

function running(message: string): ToolProgress {
  return { status: "running", message };
}

/**
 * Runs `work` while yielding its progress reports as preliminary tool results.
 * Bursts of reports are coalesced so the UI only gets the latest one.
 */
async function* withProgress<T>(work: (report: (message: string) => void) => Promise<T>): AsyncGenerator<ToolProgress, T> {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let result: T | undefined;
  let failure: { error: unknown } | undefined;

  const report = (message: string) => {
    queue.push(message);
    wake?.();
  };
  void work(report)
    .then((r) => (result = r), (error) => (failure = { error }))
    .finally(() => {
      finished = true;
      wake?.();
    });

  while (true) {
    if (queue.length) {
      yield running(queue.splice(0).at(-1)!);
      continue;
    }
    if (finished) break;
    await new Promise<void>((resolve) => (wake = resolve));
    wake = null;
  }
  if (failure) throw failure.error;
  return result as T;
}

interface PlaylistAnalysis {
  playlist: string;
  playlistId?: string;
  error?: string;
  totalTracks?: number;
  engagedCount?: number;
  tooNewToJudgeCount?: number;
  underplayedCount?: number;
  underplayed: (CompactTrack & { addedAt: string | null; artistIsFavorite: boolean })[];
  method?: string;
}

function stripFieldFilters(query: string): string {
  return query.replace(/\b(track|artist|album|year|genre|isrc|tag):/gi, " ").replace(/["']/g, " ").replace(/\s+/g, " ").trim();
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Accepts a full `spotify:track:` URI, an open.spotify.com track URL, or a bare 22-char ID. */
function toTrackUri(ref: string): string {
  const trimmed = ref.trim();
  if (TRACK_URI.test(trimmed)) return trimmed;
  const id = trimmed.match(/(?:track[/:])?([A-Za-z0-9]{22})(?:\?.*)?$/)?.[1];
  return id ? `spotify:track:${id}` : trimmed;
}

/** 22-char ID of a track URI: what the model sees, to keep prompts small. */
const shortId = (uri: string) => uri.replace(/^spotify:track:/, "");

// ---------- Compact, model-facing tool results ----------

/** Model-facing text result (much smaller than the JSON the UI receives). */
const modelText = (value: string) => ({ type: "text" as const, value });
const trackLine = (t: { name: string; artists: string }) => `${t.name} — ${t.artists}`;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "?");

function capped(lines: string[], max: number, more = ""): string {
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n…and ${lines.length - max} more${more}`;
}

/** Preliminary yields never reach the model, but the output type includes them. */
function isDone<T extends { status: string }>(output: T): output is Extract<T, { status: "done" }> {
  return output.status === "done";
}

/**
 * Rebuilds collections from earlier tool results in the chat history, so collectionIds stay
 * valid for the whole conversation. Collection-producing tools put their URIs in
 * `collectionUris` (sent to the UI only, never to the model).
 */
export function collectionsFromHistory(messages: { parts: unknown[] }[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const message of messages) {
    for (const part of message.parts) {
      const output = (part as { state?: string; output?: { collectionId?: unknown; collectionUris?: unknown } }).output;
      if (
        (part as { state?: string }).state === "output-available" &&
        typeof output?.collectionId === "string" &&
        Array.isArray(output.collectionUris)
      ) {
        found.set(output.collectionId, output.collectionUris.filter((u): u is string => typeof u === "string"));
      }
    }
  }
  return found;
}

type CardExtra = Pick<PlaylistCardData, "added" | "removed" | "skippedDuplicates">;

/** Preview data for the playlist card (name, cover, first tracks). Never throws: the write already succeeded. */
export async function buildPlaylistCard(
  token: string,
  playlistId: string,
  extra: CardExtra,
  signal?: AbortSignal,
): Promise<PlaylistCardData> {
  let details: PlaylistDetails | undefined;
  let sample: CompactTrack[] = [];
  try {
    const res = await getPlaylistTracks(token, playlistId, { maxTracks: 8, signal });
    details = res.details;
    sample = res.tracks.slice(0, 8);
  } catch {
    // Preview only.
  }
  return {
    id: playlistId,
    name: details?.name ?? "Playlist",
    url: details?.url ?? playlistUrl(playlistId),
    imageUrl: details?.imageUrl ?? null,
    total: details?.total ?? null,
    sample: sample.map(({ name, artists }) => ({ name, artists })),
    ...extra,
  };
}

/**
 * Builds the Spotify tool set for one chat request, bound to the user's access token.
 *
 * Search, release and stats tools register the URIs they find under a `collectionId`, so the
 * model can pass `collectionIds` to the write tools instead of echoing hundreds of URIs.
 * Each tool also has a compact `toModelOutput`: the model gets short text (no URIs, sampled
 * lists) while the UI keeps the full result. That keeps requests inside free-tier token limits.
 */
export function createSpotifyTools(token: string, seed: Map<string, string[]> = new Map()) {
  const collections = new Map(seed);
  let collectionSeq = Math.max(0, ...[...seed.keys()].map((k) => Number(k.slice(1)) || 0));

  const saveCollection = (uris: string[]) => {
    const id = `c${++collectionSeq}`;
    collections.set(id, uris);
    return id;
  };

  const resolveUris = (uris: string[] = [], collectionIds: string[] = []) => {
    const unknown = collectionIds.filter((id) => !collections.has(id));
    if (unknown.length) {
      throw new Error(`Unknown collectionIds: ${unknown.join(", ")}. Use a collectionId from an earlier tool result, or pass track IDs.`);
    }
    const all = [...uris.map(toTrackUri), ...collectionIds.flatMap((id) => collections.get(id) ?? [])];
    const invalid = all.filter((u) => !TRACK_URI.test(u));
    if (invalid.length) {
      throw new Error(`Invalid track references (expected a 22-char track ID or spotify:track: URI): ${invalid.slice(0, 5).join(", ")}`);
    }
    return [...new Set(all)];
  };

  const buildCard = (playlistId: string, extra: CardExtra, signal?: AbortSignal) =>
    buildPlaylistCard(token, playlistId, extra, signal);

  return {
    getUserPlaylists: tool({
      description:
        "List the user's playlists (owned and followed) with id, owner, whether the user owns it, and track count. Use this to find a playlist ID by name.",
      inputSchema: z.object({
        nameContains: z.string().optional().describe("Optional case-insensitive filter on playlist name."),
      }),
      async *execute({ nameContains }, { abortSignal }) {
        yield running("Loading your playlists…");
        const all = await getUserPlaylists(token, abortSignal);
        const needle = nameContains?.toLowerCase();
        const playlists = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all;
        yield {
          status: "done" as const,
          message: needle ? `Found ${playlists.length} of ${all.length} playlists matching “${nameContains}”` : `Found ${all.length} playlists`,
          playlists,
        };
      },
      toModelOutput: ({ output }) => {
        if (!isDone(output)) return modelText(output.message);
        const lines = output.playlists.map(
          (p) =>
            `${p.id} | ${p.name} | ${p.trackCount ?? "?"} tracks | ${p.ownedByYou ? "owned" : `by ${p.owner}`}${p.collaborative ? ", collaborative" : ""}`,
        );
        return modelText(`${output.message}\nid | name | tracks | owner\n${capped(lines, 150, " (use nameContains to narrow)")}`);
      },
    }),

    getPlaylistTracks: tool({
      description:
        "Get the full tracklist of a playlist (paginates automatically, any size). Spotify only returns contents of playlists the user owns or collaborates on.",
      inputSchema: z.object({
        playlistId: z.string().describe("Playlist ID, spotify:playlist: URI, or open.spotify.com URL."),
        maxTracks: z.number().int().min(1).max(10000).default(2000),
      }),
      async *execute({ playlistId, maxTracks }, { abortSignal }) {
        const id = parsePlaylistId(playlistId);
        yield running("Reading playlist…");
        const { details, tracks, accessible } = yield* withProgress((report) =>
          getPlaylistTracks(token, id, {
            maxTracks,
            signal: abortSignal,
            onProgress: (n, total) => report(`Read ${n}${total ? ` of ${total}` : ""} tracks…`),
          }),
        );
        const collectionUris = tracks.map((t) => t.uri);
        yield {
          status: "done" as const,
          message: accessible ? `Read ${tracks.length} tracks from “${details.name}”` : `“${details.name}” isn't readable`,
          playlist: details,
          accessible,
          note: accessible ? undefined : "Spotify only exposes the contents of playlists the user owns or collaborates on.",
          collectionId: accessible ? saveCollection(collectionUris) : undefined,
          collectionUris: accessible ? collectionUris : undefined,
          tracks,
        };
      },
      toModelOutput: ({ output }) => {
        if (!isDone(output)) return modelText(output.message);
        if (!output.accessible) return modelText(`${output.message}. ${output.note}`);
        const lines = output.tracks.map((t) => `${shortId(t.uri)} | ${trackLine(t)} | added ${day(t.addedAt)}`);
        return modelText(
          `${output.message} (playlist id ${output.playlist.id}). All its tracks are saved as collectionId ${output.collectionId}.\n` +
            `trackId | title — artists | added\n${capped(lines, 300, " (for pruning, use getUserListeningStats with analyzePlaylistId)")}`,
        );
      },
    }),

    searchTracks: tool({
      description:
        "Search the Spotify catalog for many queries at once (up to 250). Results are deduplicated across queries (same URI or same title + primary artist) and saved under a collectionId you can pass to createPlaylist/updatePlaylistTracks. " +
        "For specific songs use one query per song like `track:Gurenge artist:LiSA` with resultsPerQuery 1. For broad discovery use descriptive queries with a higher resultsPerQuery. Supported filters: track:, artist:, album:, year:1990-1999, genre:.",
      inputSchema: z.object({
        queries: z.array(z.string().min(1)).min(1).max(250),
        resultsPerQuery: z.number().int().min(1).max(50).default(1).describe("Tracks to take per query. Spotify pages 10 at a time."),
        excludeUris: z.array(z.string()).optional().describe("Track URIs to leave out, e.g. songs already in the playlist."),
        maxTracks: z.number().int().min(1).max(2000).optional().describe("Stop once this many unique tracks are collected."),
      }),
      async *execute({ queries, resultsPerQuery, excludeUris, maxTracks }, { abortSignal }) {
        yield running(`Searching Spotify for ${queries.length} ${queries.length === 1 ? "query" : "queries"}…`);

        const perQuery = yield* withProgress(async (report) => {
          let done = 0;
          return mapLimit(queries, 4, async (q) => {
            let found = await searchTracks(token, q, { limit: resultsPerQuery, signal: abortSignal });
            const plain = stripFieldFilters(q);
            if (found.length === 0 && plain !== q && plain) {
              found = await searchTracks(token, plain, { limit: resultsPerQuery, signal: abortSignal });
            }
            report(`Searched ${++done} of ${queries.length} queries…`);
            return found;
          });
        });

        const seenUris = new Set(excludeUris ?? []);
        const seenKeys = new Set<string>();
        const tracks: CompactTrack[] = [];
        const notFound: string[] = [];
        perQuery.forEach((results, i) => {
          if (results.length === 0) notFound.push(queries[i]);
          for (const t of results) {
            if (maxTracks && tracks.length >= maxTracks) return;
            const key = dedupeKey(t);
            if (seenUris.has(t.uri) || seenKeys.has(key)) continue;
            seenUris.add(t.uri);
            seenKeys.add(key);
            tracks.push(compactTrack(t));
          }
        });

        const collectionUris = tracks.map((t) => t.uri);
        const collectionId = saveCollection(collectionUris);
        yield {
          status: "done" as const,
          message: `Found ${tracks.length} unique tracks${notFound.length ? ` · ${notFound.length} ${notFound.length === 1 ? "query" : "queries"} had no match` : ""}`,
          collectionId,
          collectionUris,
          totalFound: tracks.length,
          notFound,
          tracks,
        };
      },
      toModelOutput: ({ output }) => {
        if (!isDone(output)) return modelText(output.message);
        const parts = [
          `${output.totalFound} unique tracks saved as collectionId ${output.collectionId} (pass it to createPlaylist/updatePlaylistTracks; no need to list tracks).`,
        ];
        if (output.notFound.length) parts.push(`No match for ${output.notFound.length} queries:\n${capped(output.notFound, 40)}`);
        parts.push(`Sample of what was found:\n${capped(output.tracks.map(trackLine), 25)}`);
        return modelText(parts.join("\n\n"));
      },
    }),

    getUserListeningStats: tool({
      description:
        "Get the user's top artists and top tracks (short ≈ 4 weeks, medium ≈ 6 months, long ≈ years) and recently played tracks. " +
        "Pass analyzePlaylistId to flag tracks in that playlist that look underplayed: not in any top-50 list and not among the last 50 plays. " +
        "Spotify does not expose play or skip counts, so this is an inference.",
      inputSchema: z.object({
        timeRanges: z.array(z.enum(["short_term", "medium_term", "long_term"])).optional().describe("Defaults to all three."),
        limit: z.number().int().min(1).max(50).default(20).describe("Items per list returned in the result."),
        includeRecentlyPlayed: z.boolean().default(true),
        analyzePlaylistId: z.string().optional().describe("Playlist ID/URI/URL to check for underplayed tracks."),
        minDaysInPlaylist: z.number().int().min(0).max(3650).default(14).describe("Ignore tracks added more recently than this when flagging underplayed ones."),
      }),
      async *execute({ timeRanges, limit, includeRecentlyPlayed, analyzePlaylistId, minDaysInPlaylist }, { abortSignal }) {
        const ranges = timeRanges?.length ? timeRanges : ALL_RANGES;
        yield running("Analyzing your top artists and tracks…");

        const [topTracks, topArtists, recent] = await Promise.all([
          Promise.all(ranges.map((r) => getTopTracks(token, r, 50, abortSignal))),
          Promise.all(ranges.map((r) => getTopArtists(token, r, 50, abortSignal))),
          includeRecentlyPlayed || analyzePlaylistId ? getRecentlyPlayed(token, abortSignal) : Promise.resolve([]),
        ]);

        const byRange = <T, R>(lists: T[][], map: (x: T) => R) =>
          Object.fromEntries(ranges.map((r, i) => [r, lists[i].slice(0, limit).map(map)]));

        let playlistAnalysis: PlaylistAnalysis | undefined;
        if (analyzePlaylistId) {
          yield running("Reading the playlist to compare against your listening…");
          const { details, tracks, accessible } = await getPlaylistTracks(token, parsePlaylistId(analyzePlaylistId), {
            signal: abortSignal,
          });
          if (!accessible) {
            playlistAnalysis = {
              playlist: details.name,
              error: "Spotify only exposes contents of playlists the user owns or collaborates on.",
              underplayed: [],
            };
          } else {
            yield running(`Comparing ${tracks.length} tracks with your listening history…`);
            const topUris = new Map<string, TimeRange[]>();
            const topKeys = new Set<string>();
            ranges.forEach((r, i) =>
              topTracks[i].forEach((t) => {
                topUris.set(t.uri, [...(topUris.get(t.uri) ?? []), r]);
                topKeys.add(dedupeKey(t));
              }),
            );
            const recentCounts = new Map<string, number>();
            for (const { track } of recent) {
              recentCounts.set(track.uri, (recentCounts.get(track.uri) ?? 0) + 1);
              recentCounts.set(dedupeKey(track), (recentCounts.get(dedupeKey(track)) ?? 0) + 1);
            }
            const favoriteArtists = new Set(topArtists.flat().map((a) => a.name.toLowerCase()));
            const cutoff = daysAgo(minDaysInPlaylist).getTime();

            const engaged: string[] = [];
            const tooNew: string[] = [];
            const underplayed: (CompactTrack & { addedAt: string | null; artistIsFavorite: boolean })[] = [];
            for (const t of tracks) {
              const key = dedupeKey(t);
              const played = topUris.has(t.uri) || topKeys.has(key) || recentCounts.has(t.uri) || recentCounts.has(key);
              if (played) engaged.push(t.uri);
              else if (t.addedAt && Date.parse(t.addedAt) > cutoff) tooNew.push(t.uri);
              else {
                const artistIsFavorite = t.artists.split(", ").some((a) => favoriteArtists.has(a.toLowerCase()));
                underplayed.push({ ...t, artistIsFavorite });
              }
            }
            // Strongest prune candidates first: not by a favourite artist, then added longest ago.
            underplayed.sort(
              (a, b) =>
                Number(a.artistIsFavorite) - Number(b.artistIsFavorite) ||
                (Date.parse(a.addedAt ?? "1970") || 0) - (Date.parse(b.addedAt ?? "1970") || 0),
            );
            playlistAnalysis = {
              playlistId: details.id,
              playlist: details.name,
              totalTracks: tracks.length,
              engagedCount: engaged.length,
              tooNewToJudgeCount: tooNew.length,
              underplayedCount: underplayed.length,
              underplayed,
              method:
                "Underplayed = not in your top 50 tracks for any time range and not in your last 50 plays, and in the playlist for at least minDaysInPlaylist days. Tracks by favourite artists are listed last.",
            };
          }
        }

        const collectionUris = [...new Set(topTracks.flat().map((t) => t.uri))];
        yield {
          status: "done" as const,
          message: playlistAnalysis?.underplayedCount !== undefined
            ? `Flagged ${playlistAnalysis.underplayedCount} likely underplayed tracks in “${playlistAnalysis.playlist}”`
            : "Analyzed your listening history",
          ranges,
          topArtists: byRange(topArtists, (a) => ({ id: a.id, name: a.name, genres: a.genres?.slice(0, 3) })),
          topTracks: byRange(topTracks, (t) => compactTrack(t)),
          recentlyPlayed: includeRecentlyPlayed
            ? recent.slice(0, limit).map(({ track, played_at }) => ({ ...compactTrack(track), playedAt: played_at }))
            : undefined,
          collectionId: saveCollection(collectionUris),
          collectionUris,
          playlistAnalysis,
        };
      },
      toModelOutput: ({ output }) => {
        if (!isDone(output)) return modelText(output.message);
        const sections: string[] = [output.message];
        for (const range of output.ranges) {
          const artists = (output.topArtists[range] ?? []).map((a) => `${a.id} ${a.name}`);
          const tracks = (output.topTracks[range] ?? []).map(trackLine);
          sections.push(`Top artists, ${range} (artistId name):\n${artists.join("\n")}`);
          sections.push(`Top tracks, ${range}:\n${tracks.join("\n")}`);
        }
        sections.push(`All top tracks (every range) are saved as collectionId ${output.collectionId}.`);
        if (output.recentlyPlayed) sections.push(`Recently played:\n${output.recentlyPlayed.map(trackLine).join("\n")}`);
        const a = output.playlistAnalysis;
        if (a?.error) sections.push(`Playlist analysis (${a.playlist}): ${a.error}`);
        else if (a) {
          const lines = a.underplayed.map(
            (t) => `${shortId(t.uri)} | ${trackLine(t)} | added ${day(t.addedAt)}${t.artistIsFavorite ? " | favourite artist" : ""}`,
          );
          sections.push(
            `Playlist analysis for “${a.playlist}” (id ${a.playlistId}): ${a.totalTracks} tracks, ${a.engagedCount} played recently or in top lists, ` +
              `${a.tooNewToJudgeCount} too new to judge, ${a.underplayedCount} likely underplayed. ${a.method}\n` +
              `trackId | title — artists | added\n${capped(lines, 200)}`,
          );
        }
        return modelText(sections.join("\n\n"));
      },
    }),

    getArtistsLatestReleases: tool({
      description:
        "Get recent albums and singles for a list of artist IDs (e.g. from getUserListeningStats), with their tracks. All found track URIs are saved under a collectionId.",
      inputSchema: z.object({
        artistIds: z.array(z.string()).min(1).max(30),
        sinceDays: z.number().int().min(1).max(730).default(90).describe("Only releases from the last N days."),
        includeGroups: z.array(z.enum(["album", "single"])).default(["album", "single"]),
        maxTracksPerRelease: z.number().int().min(1).max(50).default(5),
      }),
      async *execute({ artistIds, sinceDays, includeGroups, maxTracksPerRelease }, { abortSignal }) {
        const since = daysAgo(sinceDays);
        yield running(`Checking new releases from ${artistIds.length} artists…`);

        const perArtist = yield* withProgress(async (report) => {
          let done = 0;
          return mapLimit([...new Set(artistIds)], 3, async (id) => {
            const releases = await getArtistReleasesSince(token, id, since, includeGroups, abortSignal);
            report(`Checked ${++done} of ${artistIds.length} artists…`);
            return releases;
          });
        });

        const releases = [...new Map(perArtist.flat().map((r) => [r.id, r])).values()];
        const withTracks = yield* withProgress(async (report) => {
          let done = 0;
          return mapLimit(releases, 4, async (r) => {
            const tracks = await getAlbumTracks(token, r, maxTracksPerRelease, abortSignal);
            report(`Loaded tracks for ${++done} of ${releases.length} releases…`);
            return { ...r, tracks: tracks.map(({ uri, name }) => ({ uri, name })) };
          });
        });

        const uris = [...new Set(withTracks.flatMap((r) => r.tracks.map((t) => t.uri)))];
        yield {
          status: "done" as const,
          message: `Found ${withTracks.length} releases since ${since.toISOString().slice(0, 10)} (${uris.length} tracks)`,
          collectionId: saveCollection(uris),
          collectionUris: uris,
          totalTracks: uris.length,
          releases: withTracks,
        };
      },
      toModelOutput: ({ output }) => {
        if (!isDone(output)) return modelText(output.message);
        const lines = output.releases.map((r) => `${r.releaseDate} | ${r.type} | ${r.name} — ${r.artists} | ${r.tracks.length} tracks`);
        return modelText(
          `${output.message}. All their tracks are saved as collectionId ${output.collectionId}.\n` +
            `released | type | title — artists | tracks\n${capped(lines, 60)}`,
        );
      },
    }),

    createPlaylist: tool({
      description:
        "Create a new playlist in the user's library and add tracks (any number; sent in batches of 100). Prefer collectionIds from earlier tool results in this conversation; trackUris also accepts bare 22-char track IDs.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(300).optional(),
        public: z.boolean().default(false),
        trackUris: z.array(z.string()).optional(),
        collectionIds: z.array(z.string()).optional(),
        maxTracks: z.number().int().min(1).max(10000).optional().describe("Truncate the combined track list to this many."),
      }),
      async *execute({ name, description, public: isPublic, trackUris, collectionIds, maxTracks }, { abortSignal }) {
        let uris = resolveUris(trackUris, collectionIds);
        if (maxTracks) uris = uris.slice(0, maxTracks);

        yield running(`Creating “${name}”…`);
        const playlist = await createPlaylist(token, { name, description, isPublic }, abortSignal);

        if (uris.length) {
          yield running(`Adding ${uris.length} songs to the playlist…`);
          yield* withProgress((report) =>
            addTracksToPlaylist(token, playlist.id, uris, {
              signal: abortSignal,
              onChunk: (done, total) => report(`Added ${done} of ${total} songs…`),
            }),
          );
        }

        yield running("Preparing preview…");
        const card = await buildCard(playlist.id, { added: uris.length, removed: 0 }, abortSignal);
        yield {
          status: "done" as const,
          message: `Created “${card.name}” with ${uris.length} tracks`,
          playlist: card,
        };
      },
      toModelOutput: ({ output }) =>
        modelText(isDone(output) ? `${output.message} (playlist id ${output.playlist.id}). The user sees a preview card with a Spotify link.` : output.message),
    }),

    updatePlaylistTracks: tool({
      description:
        "Add and/or remove tracks on an existing playlist the user owns or collaborates on. Track references can be bare 22-char track IDs (as shown in tool results) or spotify:track: URIs. Removal deletes every occurrence. Adds skip tracks already in the playlist unless skipDuplicates is false.",
      inputSchema: z.object({
        playlistId: z.string().describe("Playlist ID, spotify:playlist: URI, or open.spotify.com URL."),
        addUris: z.array(z.string()).optional(),
        addCollectionIds: z.array(z.string()).optional(),
        removeUris: z.array(z.string()).optional(),
        position: z.number().int().min(0).optional().describe("Insert position for added tracks; appends when omitted."),
        skipDuplicates: z.boolean().default(true),
      }),
      async *execute({ playlistId, addUris, addCollectionIds, removeUris, position, skipDuplicates }, { abortSignal }) {
        const id = parsePlaylistId(playlistId);
        let toAdd = resolveUris(addUris, addCollectionIds);
        const toRemove = resolveUris(removeUris);
        if (!toAdd.length && !toRemove.length) throw new Error("Nothing to do: provide addUris, addCollectionIds or removeUris.");

        let skippedDuplicates = 0;
        if (toAdd.length && skipDuplicates) {
          yield running("Checking for songs already in the playlist…");
          const { tracks, accessible } = await getPlaylistTracks(token, id, { signal: abortSignal });
          if (!accessible) throw new Error("This playlist can't be edited: the user doesn't own or collaborate on it.");
          const removing = new Set(toRemove);
          const existing = new Set(tracks.map((t) => t.uri).filter((u) => !removing.has(u)));
          const before = toAdd.length;
          toAdd = toAdd.filter((u) => !existing.has(u));
          skippedDuplicates = before - toAdd.length;
        }

        if (toRemove.length) {
          yield running(`Removing ${toRemove.length} songs…`);
          yield* withProgress((report) =>
            removeTracksFromPlaylist(token, id, toRemove, {
              signal: abortSignal,
              onChunk: (done, total) => report(`Removed ${done} of ${total} songs…`),
            }),
          );
        }
        if (toAdd.length) {
          yield running(`Adding ${toAdd.length} songs…`);
          yield* withProgress((report) =>
            addTracksToPlaylist(token, id, toAdd, {
              position,
              signal: abortSignal,
              onChunk: (done, total) => report(`Added ${done} of ${total} songs…`),
            }),
          );
        }

        yield running("Preparing preview…");
        const card = await buildCard(id, { added: toAdd.length, removed: toRemove.length, skippedDuplicates }, abortSignal);
        yield {
          status: "done" as const,
          message: `Updated “${card.name}”: +${toAdd.length} / −${toRemove.length}${skippedDuplicates ? ` (${skippedDuplicates} already there)` : ""}`,
          playlist: card,
        };
      },
      toModelOutput: ({ output }) =>
        modelText(isDone(output) ? `${output.message}. The user sees a preview card with a Spotify link.` : output.message),
    }),
  };
}

export type SpotifyTools = ReturnType<typeof createSpotifyTools>;
