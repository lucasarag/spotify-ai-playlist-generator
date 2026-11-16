"use client";

import Image from "next/image";
import { useState } from "react";
import type { PlaylistCardData } from "@/lib/ai/tool-output";

export function PlaylistCard({ data }: { data: PlaylistCardData }) {
  const [showPlayer, setShowPlayer] = useState(false);

  return (
    <article className="overflow-hidden rounded-2xl bg-panel shadow-[0_1px_0_var(--color-line),0_20px_40px_-28px_rgba(25,21,46,0.35)]">
      <div className="flex gap-4 p-4 sm:gap-5 sm:p-5">
        <div className="relative size-24 shrink-0 overflow-hidden rounded-lg bg-ultra sm:size-28">
          {data.imageUrl ? (
            <Image src={data.imageUrl} alt="" fill sizes="112px" className="object-cover" />
          ) : (
            <span aria-hidden className="font-display absolute inset-0 flex items-end p-2.5 text-3xl leading-none font-bold text-white/90">
              {data.name.slice(0, 2)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="font-display truncate text-xl leading-tight font-semibold tracking-tight sm:text-2xl">{data.name}</h3>
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            {data.total !== null && (
              <div className="flex gap-1">
                <dt className="sr-only">Total tracks</dt>
                <dd>{data.total} tracks</dd>
              </div>
            )}
            {data.added > 0 && (
              <div className="flex gap-1">
                <dt className="sr-only">Added</dt>
                <dd className="text-ok">+{data.added} added</dd>
              </div>
            )}
            {data.removed > 0 && (
              <div className="flex gap-1">
                <dt className="sr-only">Removed</dt>
                <dd className="text-danger">−{data.removed} removed</dd>
              </div>
            )}
            {!!data.skippedDuplicates && (
              <div className="flex gap-1">
                <dt className="sr-only">Skipped</dt>
                <dd>{data.skippedDuplicates} already in playlist</dd>
              </div>
            )}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ultra-deep"
            >
              Open in Spotify
            </a>
            <button
              type="button"
              onClick={() => setShowPlayer((v) => !v)}
              aria-expanded={showPlayer}
              className="rounded-full border border-line px-4 py-2 text-sm font-semibold transition-colors hover:border-ink"
            >
              {showPlayer ? "Hide player" : "Show player"}
            </button>
          </div>
        </div>
      </div>

      {showPlayer ? (
        <iframe
          title={`Spotify player for ${data.name}`}
          src={`https://open.spotify.com/embed/playlist/${data.id}`}
          className="block h-[352px] w-full border-0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
        />
      ) : (
        data.sample.length > 0 && (
          <ol className="border-t border-line px-4 py-3 text-sm sm:px-5">
            {data.sample.map((t, i) => (
              <li key={`${t.name}-${i}`} className="flex gap-3 py-1">
                <span className="w-5 shrink-0 text-right text-muted tabular-nums">{i + 1}</span>
                <span className="min-w-0 truncate">
                  {t.name} <span className="text-muted">{t.artists}</span>
                </span>
              </li>
            ))}
            {data.total !== null && data.total > data.sample.length && (
              <li className="py-1 pl-8 text-muted">and {data.total - data.sample.length} more</li>
            )}
          </ol>
        )
      )}
    </article>
  );
}
