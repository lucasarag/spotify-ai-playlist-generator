/**
 * Low-level Spotify Web API helpers: authenticated fetch with retry/backoff,
 * pagination, chunking and bounded concurrency.
 */

export const SPOTIFY_API = "https://api.spotify.com/v1";

/** Spotify's hard limit for URIs per add/remove request. */
export const MAX_URIS_PER_REQUEST = 100;

/** Longer Retry-After values usually mean a rolling-window ban; fail fast instead of hanging the request. */
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_BACKOFF_MS = 30_000;

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "SpotifyApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface SpotifyRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  maxRetries?: number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with jitter: 500ms, 1s, 2s, 4s… capped at 30s. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function buildUrl(pathOrUrl: string, query?: Query): string {
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${SPOTIFY_API}${pathOrUrl}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error?.message ?? data?.error_description ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Authenticated request to the Spotify Web API.
 * Retries on 429 (honouring Retry-After), 5xx and network errors with exponential backoff.
 */
export async function spotifyFetch<T = unknown>(
  token: string,
  pathOrUrl: string,
  { method = "GET", query, body, signal, maxRetries = 5 }: SpotifyRequest = {},
): Promise<T> {
  const url = buildUrl(pathOrUrl, query);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (err) {
      if (signal?.aborted || attempt >= maxRetries) throw err;
      await sleep(backoffDelay(attempt), signal);
      continue;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "0");
      if (retryAfter > MAX_RETRY_AFTER_SECONDS || attempt >= maxRetries) {
        throw new SpotifyApiError(
          `Spotify rate limit reached. Try again in ${retryAfter > 0 ? `${retryAfter}s` : "a moment"}.`,
          429,
          pathOrUrl,
        );
      }
      await sleep(Math.max(retryAfter * 1000, backoffDelay(attempt)), signal);
      continue;
    }

    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(backoffDelay(attempt), signal);
      continue;
    }

    if (!res.ok) {
      throw new SpotifyApiError(
        `Spotify ${method} ${new URL(url).pathname} failed (${res.status}): ${await readErrorMessage(res)}`,
        res.status,
        pathOrUrl,
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export interface Paging<T> {
  items: T[];
  next: string | null;
  total?: number;
}

/** Follows `next` links until exhausted or `maxItems` collected. */
export async function paginate<T>(
  token: string,
  firstPage: Paging<T> | string,
  { maxItems = Infinity, signal, onPage }: { maxItems?: number; signal?: AbortSignal; onPage?: (count: number, total?: number) => void } = {},
): Promise<T[]> {
  const out: T[] = [];
  let page: Paging<T> | null =
    typeof firstPage === "string" ? await spotifyFetch<Paging<T>>(token, firstPage, { signal }) : firstPage;

  while (page) {
    out.push(...(page.items ?? []));
    onPage?.(out.length, page.total);
    if (!page.next || out.length >= maxItems) break;
    page = await spotifyFetch<Paging<T>>(token, page.next, { signal });
  }
  return out.slice(0, maxItems);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
