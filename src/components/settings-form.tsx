"use client";

import { type FormEvent, useState } from "react";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "@/lib/ai/providers";
import type { Settings } from "@/lib/client/settings";
import { redirectUri } from "@/lib/client/spotify-auth";

const CLIENT_ID = /^[0-9a-f]{32}$/i;

const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2.5 text-[0.95rem] placeholder:text-muted/70 focus:border-ultra focus:outline-none";

export function SettingsForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Settings;
  submitLabel: string;
  onSubmit: (settings: Settings) => void;
  onCancel?: () => void;
}) {
  const [clientId, setClientId] = useState(initial.spotifyClientId);
  const [provider, setProvider] = useState<ProviderId>(PROVIDER_IDS.find((id) => initial.keys[id]) ?? "google");
  const [keys, setKeys] = useState(initial.keys);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callback = redirectUri();

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(callback);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; the URI is selectable text.
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = clientId.trim();
    if (!CLIENT_ID.test(id)) {
      setError("The Spotify Client ID is a 32-character code from your app's Settings page in the Spotify dashboard.");
      return;
    }
    const cleaned = Object.fromEntries(
      Object.entries(keys).map(([k, v]) => [k, v?.trim() ?? ""]).filter(([, v]) => v),
    ) as Settings["keys"];
    if (!Object.keys(cleaned).length) {
      setError("Paste at least one AI provider key. All of them have free tiers; adding several gives Crate backups when one is busy or out of quota.");
      return;
    }
    setError(null);
    onSubmit({ spotifyClientId: id, keys: cleaned });
  };

  return (
    <form onSubmit={submit} className="space-y-7" noValidate>
      <fieldset className="space-y-3">
        <legend className="font-display text-lg font-semibold">1. Your Spotify app</legend>
        <p className="text-sm text-muted">
          Create a free app in the{" "}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" className="text-ultra underline underline-offset-2">
            Spotify developer dashboard
          </a>
          , tick <em>Web API</em>, and add this redirect URI exactly:
        </p>
        <div className="flex items-center gap-2 rounded-lg bg-ultra-soft px-3 py-2">
          <code className="min-w-0 flex-1 truncate text-sm select-all">{callback}</code>
          <button type="button" onClick={copyRedirect} className="shrink-0 text-sm font-semibold text-ultra-deep">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Client ID</span>
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="32-character ID from the app's Settings page"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-display text-lg font-semibold">2. Your AI keys</legend>
        <p className="text-sm text-muted">
          Add one or more (all have free tiers). More keys means more models to fall back on when one is busy or out of quota. Crate picks the best and fastest model automatically.
        </p>
        <div role="tablist" aria-label="AI provider" className="flex w-fit flex-wrap gap-0.5 rounded-2xl bg-panel p-0.5 text-sm shadow-[0_0_0_1px_var(--color-line)]">
          {PROVIDER_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={provider === id}
              onClick={() => setProvider(id)}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 font-medium transition-colors ${provider === id ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {PROVIDERS[id].label}
              {keys[id]?.trim() && <span aria-label="key added" className="size-1.5 rounded-full bg-ok" />}
            </button>
          ))}
        </div>
        <label className="block space-y-1.5">
          <span className="flex items-baseline justify-between gap-2 text-sm font-medium">
            {PROVIDERS[provider].label} API key
            <a href={PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer" className="font-normal text-ultra underline underline-offset-2">
              Get a free key
            </a>
          </span>
          <input
            type="password"
            value={keys[provider] ?? ""}
            onChange={(e) => setKeys((k) => ({ ...k, [provider]: e.target.value }))}
            placeholder={PROVIDERS[provider].keyHint}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </label>
        <p className="text-sm text-muted">
          {PROVIDERS[provider].note} Keys are saved in this browser only and never stored on the server.
        </p>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="rounded-full bg-ultra px-6 py-3 font-semibold text-white transition-colors hover:bg-ultra-deep">
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-full border border-line px-6 py-3 font-semibold hover:border-ink">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
