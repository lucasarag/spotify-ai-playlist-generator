/**
 * Spotify Authorization Code flow with PKCE, run entirely in the browser.
 * Needs only the (public) Client ID: no client secret, no server session.
 * https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
 */
import { readJson, remove, writeJson } from "./storage";

export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-email",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-top-read",
  "user-read-recently-played",
].join(" ");

const TOKENS_KEY = "crate.spotify.tokens.v1";
const PENDING_KEY = "crate.spotify.pending.v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
/** Refresh this many seconds before the access token actually expires. */
const EXPIRY_MARGIN_SECONDS = 120;

interface StoredTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds */
  expiresAt: number;
}

interface PendingLogin {
  clientId: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

/** The exact redirect URI users must register in their Spotify app. */
export function redirectUri(): string {
  return `${window.location.origin}/callback`;
}

function randomString(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(values);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw Object.assign(new Error(data.error_description ?? data.error ?? `Spotify token request failed (${res.status})`), {
      status: res.status,
    });
  }
  return data;
}

function store(clientId: string, data: TokenResponse, previousRefresh?: string): StoredTokens {
  const tokens: StoredTokens = {
    clientId,
    accessToken: data.access_token,
    // Spotify may omit a new refresh token; keep the previous one in that case.
    refreshToken: data.refresh_token ?? previousRefresh ?? "",
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
  };
  writeJson(TOKENS_KEY, tokens);
  return tokens;
}

/** Redirects the browser to Spotify's consent screen. */
export async function beginLogin(clientId: string): Promise<void> {
  const pending: PendingLogin = {
    clientId: clientId.trim(),
    verifier: randomString(64),
    state: randomString(16),
    redirectUri: redirectUri(),
  };
  writeJson(PENDING_KEY, pending);

  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({
    client_id: pending.clientId,
    response_type: "code",
    redirect_uri: pending.redirectUri,
    scope: SPOTIFY_SCOPES,
    state: pending.state,
    code_challenge_method: "S256",
    code_challenge: await codeChallenge(pending.verifier),
  }).toString();
  window.location.assign(url.toString());
}

/** Handles the `/callback?code=…&state=…` redirect from Spotify. */
export async function completeLogin(params: URLSearchParams): Promise<void> {
  const error = params.get("error");
  if (error) {
    throw new Error(error === "access_denied" ? "You declined access on Spotify." : `Spotify returned an error: ${error}`);
  }
  const pending = readJson<PendingLogin>(PENDING_KEY);
  const code = params.get("code");
  if (!pending || !code) throw new Error("This sign-in link is incomplete or was already used. Start again from the home page.");
  if (params.get("state") !== pending.state) throw new Error("Sign-in state didn't match. Start again from the home page.");

  remove(PENDING_KEY);
  const data = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  store(pending.clientId, data);
}

export function hasSession(clientId: string): boolean {
  const tokens = readJson<StoredTokens>(TOKENS_KEY);
  return !!tokens?.refreshToken && tokens.clientId === clientId.trim();
}

let inflightRefresh: Promise<string | null> | null = null;

/**
 * A valid access token, refreshed automatically when close to expiry.
 * Returns null when there's no session or the refresh token was revoked.
 */
export async function getAccessToken(): Promise<string | null> {
  const tokens = readJson<StoredTokens>(TOKENS_KEY);
  if (!tokens) return null;
  if (Date.now() / 1000 < tokens.expiresAt - EXPIRY_MARGIN_SECONDS) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  inflightRefresh ??= requestToken({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
  })
    .then((data) => store(tokens.clientId, data, tokens.refreshToken).accessToken)
    .catch((err: { status?: number }) => {
      // Revoked/invalid refresh token: drop the session. Network errors propagate instead.
      if (err.status === 400 || err.status === 401) {
        remove(TOKENS_KEY);
        return null;
      }
      throw err;
    })
    .finally(() => {
      inflightRefresh = null;
    });
  return inflightRefresh;
}

export function signOut(): void {
  remove(TOKENS_KEY);
  remove(PENDING_KEY);
}
