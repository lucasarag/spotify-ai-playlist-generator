/** AI provider catalogue shared by the server and the settings UI (no secrets, no server-only code). */

export type ProviderId = "google" | "groq" | "cerebras" | "mistral" | "openrouter";

export interface ProviderInfo {
  label: string;
  keyUrl: string;
  keyHint: string;
  /** One line shown under the key field. */
  note: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  google: {
    label: "Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    note: "Best song knowledge. Free daily quotas per model; newest models are often busy.",
  },
  groq: {
    label: "Groq",
    keyUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    note: "Very fast. Free tier caps tokens per minute, so very long agent chats may not fit.",
  },
  cerebras: {
    label: "Cerebras",
    keyUrl: "https://cloud.cerebras.ai/",
    keyHint: "csk-…",
    note: "Extremely fast, generous daily tokens. Small context on the free tier (fine for quick playlists).",
  },
  mistral: {
    label: "Mistral",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyHint: "Mistral API key",
    note: "Large free monthly allowance, but few requests per minute. Free tier may use data for training unless you opt out.",
  },
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyHint: "sk-or-…",
    note: "Uses only its free (:free) models. Low daily request cap unless the account has credits.",
  },
};

/** Order also sets how providers are interleaved in the fallback chain. */
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDERS;
}
