import { PROVIDER_IDS, type ProviderId } from "@/lib/ai/providers";
import { readJson, writeJson } from "./storage";

/**
 * Per-user configuration, kept only in this browser's localStorage.
 * Nothing here is stored on the server; AI keys travel with each chat request,
 * and the server picks the best available model for them automatically.
 */
export interface Settings {
  spotifyClientId: string;
  keys: Partial<Record<ProviderId, string>>;
}

const KEY = "crate.settings.v1";

export const EMPTY_SETTINGS: Settings = {
  spotifyClientId: process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? "",
  keys: {},
};

export function loadSettings(): Settings {
  const saved = readJson<Partial<Settings>>(KEY);
  return {
    spotifyClientId: saved?.spotifyClientId || EMPTY_SETTINGS.spotifyClientId,
    keys: { ...saved?.keys },
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(KEY, settings);
}

/** Providers the user has entered a key for. */
export function configuredProviders(settings: Settings): ProviderId[] {
  return PROVIDER_IDS.filter((id) => !!settings.keys[id]?.trim());
}

export function isReady(settings: Settings): boolean {
  return !!settings.spotifyClientId.trim() && configuredProviders(settings).length > 0;
}
