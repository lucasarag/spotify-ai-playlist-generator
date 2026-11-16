"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Equalizer } from "@/components/tool-step";
import { completeLogin } from "@/lib/client/spotify-auth";

export default function SpotifyCallback() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Authorization codes are single-use; guard against StrictMode's double effect.
    if (started.current) return;
    started.current = true;
    completeLogin(new URLSearchParams(window.location.search))
      .then(() => window.location.replace("/"))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-4">
      {error ? (
        <div role="alert" className="space-y-4">
          <h1 className="font-display text-3xl font-bold tracking-tight">Spotify didn&apos;t connect</h1>
          <p className="text-muted">{error}</p>
          <Link href="/" className="inline-block rounded-full bg-ultra px-6 py-3 font-semibold text-white hover:bg-ultra-deep">
            Back to setup
          </Link>
        </div>
      ) : (
        <p className="flex items-center gap-3 font-medium">
          <Equalizer label="Connecting" /> Connecting to Spotify…
        </p>
      )}
    </main>
  );
}
