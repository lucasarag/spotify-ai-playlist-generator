"use client";

import type { Settings } from "@/lib/client/settings";
import { SettingsForm } from "./settings-form";

export function Landing({
  settings,
  notice,
  onConnect,
}: {
  settings: Settings;
  notice: string | null;
  onConnect: (settings: Settings) => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-8 sm:px-8">
      <p className="font-display text-xl font-semibold tracking-tight">Crate</p>

      <div className="grid flex-1 items-start gap-12 py-10 md:grid-cols-[1fr_1fr] md:py-16">
        <section className="md:sticky md:top-16">
          <h1 className="font-display text-5xl leading-[1.02] font-bold tracking-tight text-balance sm:text-6xl">
            Say the playlist. Crate builds it in your Spotify.
          </h1>
          <p className="mt-6 max-w-[34rem] text-lg text-muted">
            Ask for 200 anime openings, a tidy-up of a playlist you&apos;ve outgrown, or new releases from the artists you play most.
            An AI agent searches the catalog, reads your listening history and makes the changes.
          </p>
          <p className="mt-6 max-w-[34rem] text-muted">
            Crate runs on your own free accounts: a Spotify developer app and a free AI key (Gemini, Groq, Cerebras, Mistral or OpenRouter). Setup takes about three minutes,
            and everything stays in this browser.
          </p>
        </section>

        <section className="rounded-2xl bg-panel/70 p-5 shadow-[0_1px_0_var(--color-line),0_24px_48px_-24px_rgba(25,21,46,0.25)] sm:p-7">
          {notice && (
            <p role="alert" className="mb-6 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {notice}
            </p>
          )}
          <SettingsForm initial={settings} submitLabel="Connect Spotify" onSubmit={onConnect} />
        </section>
      </div>
    </main>
  );
}
