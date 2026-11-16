/**
 * Typed wrappers for the Spotify Web API endpoints the agent uses.
 *
 * Targets the post-February-2026 API: playlist contents live under `/items`
 * (entries expose `item`, legacy `track` is read as a fallback), playlists are
 * created via `POST /me/playlists`, search returns at most 10 results per page
 * and artist albums at most 10 per page.
 */
import {
  MAX_URIS_PER_REQUEST,
  type Paging,
  chunk,
  paginate,
  spotifyFetch,
} from "./http";

// ---------- Raw API shapes (only the fields we read) ----------

interface SpotifyImage {
  url: string;
  width?: number | null;
  height?: number | null;
}

interface SpotifyArtistRef {
  id: string;
  name: string;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  type: "track" | "episode";
  duration_ms: number;
  explicit?: boolean;
  artists?: SpotifyArtistRef[];
  album?: { id: string; name: string; release_date?: string; images?: SpotifyImage[] };
  external_urls?: { spotify?: string };
  is_local?: boolean;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres?: string[];
  images?: SpotifyImage[];
}

interface SpotifyAlbum {
  id: string;
  name: string;
  album_type: string;
  release_date: string;
  release_date_precision: "year" | "month" | "day";
  total_tracks: number;
  artists: SpotifyArtistRef[];
  external_urls?: { spotify?: string };
}

interface PlaylistEntry {
  added_at: string | null;
  is_local?: boolean;
  item?: SpotifyTrack | null;
  /** @deprecated legacy field, still read as a fallback */
  track?: SpotifyTrack | null;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  description?: string | null;
  public?: boolean | null;
  collaborative?: boolean;
  snapshot_id?: string;
  owner?: { id: string; display_name?: string | null };
  images?: SpotifyImage[] | null;
  external_urls?: { spotify?: string };
  items?: Paging<PlaylistEntry> & { total?: number };
  /** @deprecated legacy field */
  tracks?: Paging<PlaylistEntry> & { total?: number };
}

interface SpotifyUser {
  id: string;
  display_name?: string | null;
}

// ---------- Compact shapes handed to the LLM / UI ----------

export interface CompactTrack {
  uri: string;
  name: string;
  artists: string;
  album?: string;
  year?: string;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string;
  ownedByYou: boolean;
  collaborative: boolean;
  public: boolean | null;
  trackCount: number | null;
  url: string;
}

export function compactTrack(t: SpotifyTrack, album?: { name: string; release_date?: string }): CompactTrack {
  const a = album ?? t.album;
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((x) => x.name).join(", "),
    album: a?.name,
    year: a?.release_date?.slice(0, 4),
  };
}

/** Normalised "title + primary artist" key, used to drop duplicate versions (remasters, re-releases…). */
export function dedupeKey(t: Pick<SpotifyTrack, "name" | "artists"> | CompactTrack): string {
  const name = t.name
    .toLowerCase()
    .replace(
      /\s*[-–(\[].*?(remaster|version|vers[ãa]o|edit|mix|live|ao vivo|ac[úu]stic|mono|stereo|feat\.?|ft\.?|part\.|participa[çc][ãa]o|tv size).*$/i,
      "",
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const artists = typeof t.artists === "string" ? t.artists : (t.artists ?? []).map((x) => x.name).join(",");
  const primary = artists.split(",")[0]?.toLowerCase().trim() ?? "";
  return `${name}::${primary}`;
}

/** Accepts a playlist ID, `spotify:playlist:ID` URI or open.spotify.com URL. */
export function parsePlaylistId(input: string): string {
  const trimmed = input.trim();
  const uri = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  const url = trimmed.match(/open\.spotify\.com\/(?:[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  return trimmed;
}

export function playlistUrl(id: string): string {
  return `https://open.spotify.com/playlist/${id}`;
}

// ---------- User & playlists ----------

export function getMe(token: string, signal?: AbortSignal) {
  return spotifyFetch<SpotifyUser>(token, "/me", { signal });
}

export async function getUserPlaylists(token: string, signal?: AbortSignal): Promise<PlaylistSummary[]> {
  const [me, playlists] = await Promise.all([
    getMe(token, signal),
    paginate<SpotifyPlaylist | null>(token, `/me/playlists?limit=50`, { signal }),
  ]);
  return playlists
    .filter((p): p is SpotifyPlaylist => !!p)
    .map((p) => ({
      id: p.id,
      name: p.name,
      owner: p.owner?.display_name ?? p.owner?.id ?? "unknown",
      ownedByYou: p.owner?.id === me.id,
      collaborative: !!p.collaborative,
      public: p.public ?? null,
      trackCount: p.items?.total ?? p.tracks?.total ?? null,
      url: p.external_urls?.spotify ?? playlistUrl(p.id),
    }));
}

export interface PlaylistDetails {
  id: string;
  name: string;
  description: string | null;
  owner: string;
  public: boolean | null;
  snapshotId?: string;
  imageUrl: string | null;
  url: string;
  total: number | null;
}

export async function getPlaylist(token: string, playlistId: string, signal?: AbortSignal) {
  const p = await spotifyFetch<SpotifyPlaylist>(token, `/playlists/${encodeURIComponent(playlistId)}`, { signal });
  const details: PlaylistDetails = {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    owner: p.owner?.display_name ?? p.owner?.id ?? "unknown",
    public: p.public ?? null,
    snapshotId: p.snapshot_id,
    imageUrl: p.images?.[0]?.url ?? null,
    url: p.external_urls?.spotify ?? playlistUrl(p.id),
    total: p.items?.total ?? p.tracks?.total ?? null,
  };
  return { details, firstPage: p.items ?? p.tracks ?? null };
}

export interface PlaylistTrack extends CompactTrack {
  addedAt: string | null;
}

/**
 * Full tracklist of a playlist, following pagination (50 per page).
 * Spotify only returns contents for playlists the user owns or collaborates on.
 */
export async function getPlaylistTracks(
  token: string,
  playlistId: string,
  { maxTracks = 10_000, signal, onProgress }: { maxTracks?: number; signal?: AbortSignal; onProgress?: (n: number, total?: number) => void } = {},
): Promise<{ details: PlaylistDetails; tracks: PlaylistTrack[]; accessible: boolean }> {
  const { details, firstPage } = await getPlaylist(token, playlistId, signal);

  const first: Paging<PlaylistEntry> | string =
    firstPage && Array.isArray(firstPage.items)
      ? firstPage
      : `/playlists/${encodeURIComponent(details.id)}/items?limit=50&market=from_token`;

  let entries: PlaylistEntry[];
  try {
    entries = await paginate<PlaylistEntry>(token, first, { maxItems: maxTracks, signal, onPage: onProgress });
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && err.status === 403) {
      return { details, tracks: [], accessible: false };
    }
    throw err;
  }

  const tracks = entries.flatMap((e) => {
    const t = e.item ?? e.track;
    if (!t || t.type !== "track" || !t.uri) return [];
    return [{ ...compactTrack(t), addedAt: e.added_at }];
  });
  return { details, tracks, accessible: true };
}

// ---------- Search ----------

/** Track search, paging 10 at a time (Spotify's current per-request maximum). */
export async function searchTracks(
  token: string,
  query: string,
  { limit = 10, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<SpotifyTrack[]> {
  const pageSize = 10;
  const out: SpotifyTrack[] = [];
  for (let offset = 0; offset < limit && offset < 1000; offset += pageSize) {
    const data = await spotifyFetch<{ tracks?: Paging<SpotifyTrack> }>(token, "/search", {
      query: { q: query, type: "track", limit: Math.min(pageSize, limit - offset), offset, market: "from_token" },
      signal,
    });
    const items = (data.tracks?.items ?? []).filter(Boolean);
    out.push(...items);
    if (items.length === 0 || !data.tracks?.next) break;
  }
  return out;
}

// ---------- Listening stats ----------

export type TimeRange = "short_term" | "medium_term" | "long_term";

export async function getTopTracks(token: string, timeRange: TimeRange, limit = 50, signal?: AbortSignal) {
  const page = await spotifyFetch<Paging<SpotifyTrack>>(token, "/me/top/tracks", {
    query: { time_range: timeRange, limit: Math.min(limit, 50) },
    signal,
  });
  return page.items ?? [];
}

export async function getTopArtists(token: string, timeRange: TimeRange, limit = 50, signal?: AbortSignal) {
  const page = await spotifyFetch<Paging<SpotifyArtist>>(token, "/me/top/artists", {
    query: { time_range: timeRange, limit: Math.min(limit, 50) },
    signal,
  });
  return page.items ?? [];
}

export async function getRecentlyPlayed(token: string, signal?: AbortSignal) {
  const page = await spotifyFetch<Paging<{ track: SpotifyTrack; played_at: string }>>(token, "/me/player/recently-played", {
    query: { limit: 50 },
    signal,
  });
  return page.items ?? [];
}

// ---------- Artist releases ----------

export interface Release {
  id: string;
  name: string;
  type: string;
  releaseDate: string;
  artists: string;
  url: string;
  totalTracks: number;
}

function releaseDateAsTime(album: Pick<SpotifyAlbum, "release_date" | "release_date_precision">): number {
  const d = album.release_date;
  const iso = album.release_date_precision === "year" ? `${d}-12-31` : album.release_date_precision === "month" ? `${d}-28` : d;
  return Date.parse(iso);
}

/** Recent albums/singles for one artist, newest first, released on or after `since`. */
export async function getArtistReleasesSince(
  token: string,
  artistId: string,
  since: Date,
  groups: ("album" | "single")[],
  signal?: AbortSignal,
): Promise<Release[]> {
  const albums: SpotifyAlbum[] = [];
  // Query each group separately: Spotify orders results by group first, so a combined
  // query can bury fresh singles behind older albums. Limit is 10 per page.
  for (const group of groups) {
    const page = await spotifyFetch<Paging<SpotifyAlbum>>(token, `/artists/${encodeURIComponent(artistId)}/albums`, {
      query: { include_groups: group, limit: 10, market: "from_token" },
      signal,
    });
    albums.push(...(page.items ?? []));
  }
  return albums
    .filter((a) => releaseDateAsTime(a) >= since.getTime())
    .sort((a, b) => releaseDateAsTime(b) - releaseDateAsTime(a))
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.album_type,
      releaseDate: a.release_date,
      artists: a.artists.map((x) => x.name).join(", "),
      url: a.external_urls?.spotify ?? `https://open.spotify.com/album/${a.id}`,
      totalTracks: a.total_tracks,
    }));
}

export async function getAlbumTracks(
  token: string,
  release: Pick<Release, "id" | "name" | "releaseDate">,
  maxTracks: number,
  signal?: AbortSignal,
): Promise<CompactTrack[]> {
  const items = await paginate<SpotifyTrack>(
    token,
    `/albums/${encodeURIComponent(release.id)}/tracks?limit=10&market=from_token`,
    { maxItems: maxTracks, signal },
  );
  return items.map((t) => compactTrack(t, { name: release.name, release_date: release.releaseDate }));
}

// ---------- Playlist writes (chunked to 100 URIs per request) ----------

export async function createPlaylist(
  token: string,
  { name, description, isPublic }: { name: string; description?: string; isPublic: boolean },
  signal?: AbortSignal,
) {
  return spotifyFetch<SpotifyPlaylist>(token, "/me/playlists", {
    method: "POST",
    body: { name, description: description ?? "", public: isPublic },
    signal,
  });
}

/** Adds URIs in order, 100 per request. `position` inserts the whole set at that index. */
export async function addTracksToPlaylist(
  token: string,
  playlistId: string,
  uris: string[],
  { position, signal, onChunk }: { position?: number; signal?: AbortSignal; onChunk?: (done: number, total: number) => void } = {},
) {
  let snapshotId: string | undefined;
  let done = 0;
  for (const [i, batch] of chunk(uris, MAX_URIS_PER_REQUEST).entries()) {
    const res = await spotifyFetch<{ snapshot_id: string }>(token, `/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: "POST",
      body: { uris: batch, ...(position !== undefined ? { position: position + i * MAX_URIS_PER_REQUEST } : {}) },
      signal,
    });
    snapshotId = res?.snapshot_id ?? snapshotId;
    done += batch.length;
    onChunk?.(done, uris.length);
  }
  return snapshotId;
}

/** Removes every occurrence of the given URIs, 100 per request. */
export async function removeTracksFromPlaylist(
  token: string,
  playlistId: string,
  uris: string[],
  { signal, onChunk }: { signal?: AbortSignal; onChunk?: (done: number, total: number) => void } = {},
) {
  let snapshotId: string | undefined;
  let done = 0;
  for (const batch of chunk(uris, MAX_URIS_PER_REQUEST)) {
    const res = await spotifyFetch<{ snapshot_id: string }>(token, `/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: "DELETE",
      body: { items: batch.map((uri) => ({ uri })) },
      signal,
    });
    snapshotId = res?.snapshot_id ?? snapshotId;
    done += batch.length;
    onChunk?.(done, uris.length);
  }
  return snapshotId;
}
