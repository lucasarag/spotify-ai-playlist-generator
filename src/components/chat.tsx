"use client";

import { useChat } from "@ai-sdk/react";
import { type DynamicToolUIPart, type ToolUIPart, type UIMessage, DefaultChatTransport, isToolUIPart } from "ai";
import Image from "next/image";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  type ChatDataParts,
  type ChatMetadata,
  type ModelRef,
  type ModelStatus,
  type ToolOutputView,
  isPlaylistCard,
} from "@/lib/ai/tool-output";
import { readJson, writeJson } from "@/lib/client/storage";
import type { Settings } from "@/lib/client/settings";
import { getAccessToken } from "@/lib/client/spotify-auth";
import { PlaylistCard } from "./playlist-card";
import { SettingsForm } from "./settings-form";
import { Equalizer, ToolStep } from "./tool-step";

type Mode = "quick" | "agent";
const MODE_KEY = "crate.mode.v1";

const MODES: Record<Mode, { label: string; hint: { en: string; pt: string } }> = {
  quick: {
    label: "Quick playlist",
    hint: {
      en: "Fast and light on free AI limits: one AI call writes the song list, then Crate finds the songs and builds the playlist.",
      pt: "Rápido e econômico: uma chamada à IA gera a lista, e o Crate busca as músicas e monta a playlist.",
    },
  },
  agent: {
    label: "Agent",
    hint: {
      en: "For editing or analyzing playlists you already have. Uses several AI calls, so it's slower on free tiers.",
      pt: "Para editar ou analisar playlists que você já tem. Faz várias chamadas à IA, então é mais lento no plano gratuito.",
    },
  },
};

const EXAMPLES: Record<"en" | "pt", { text: string; mode: Mode }[]> = {
  en: [
    { text: "Make a 200-track playlist of anime openings and endings, from the 2000s to now", mode: "quick" },
    { text: "40 upbeat Brazilian songs for a summer road trip", mode: "quick" },
    { text: "Look at my biggest playlist and suggest songs I've stopped listening to", mode: "agent" },
    { text: "Add this year's new releases from my top 10 artists to a playlist called Fresh Picks", mode: "agent" },
  ],
  pt: [
    { text: "Crie uma playlist com 200 aberturas e encerramentos de anime, dos anos 2000 até hoje", mode: "quick" },
    { text: "40 músicas brasileiras animadas para uma viagem de verão", mode: "quick" },
    { text: "Veja minha maior playlist e sugira as músicas que eu parei de escutar", mode: "agent" },
    { text: "Adicione os lançamentos deste ano dos meus 10 artistas favoritos numa playlist chamada Novidades", mode: "agent" },
  ],
};

type ChatMessage = UIMessage<ChatMetadata, ChatDataParts>;

/** The model that answered last, remembered across requests and page reloads. */
const LAST_MODEL_KEY = "crate.lastModel.v1";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function describeStatus(status: ModelStatus | null): string {
  if (!status) return "Sending your request…";
  if (status.phase === "connecting") return `Waiting for ${status.model}…`;
  if (status.phase === "busy") return `${status.model}: ${status.reason}. Trying another model…`;
  if (status.phase === "waiting") return `All models are briefly busy. Retrying in ${status.seconds}s…`;
  return `${status.model} is working…`;
}

/** Bottom-of-chat heartbeat: what's happening right now and for how long. */
function LiveStatus({ status, startedAt }: { status: ModelStatus | null; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="flex items-center gap-3 text-sm" aria-live="polite">
      <Equalizer label="Working" />
      <span className="font-medium">{describeStatus(status)}</span>
      <span className="text-muted tabular-nums">{formatElapsed(now - startedAt)}</span>
    </p>
  );
}

/** The model's thought summaries: collapsed, with the latest line visible while it thinks. */
function Thoughts({ text, streaming }: { text: string; streaming: boolean }) {
  const latest = text.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return (
    <details className="group max-w-[68ch] text-sm text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 select-none">
        {streaming && <Equalizer />}
        <span className="font-medium">{streaming ? "Thinking" : "Thought process"}</span>
        <span className="text-xs group-open:hidden">(show)</span>
      </summary>
      {streaming && <p className="mt-1 truncate italic group-open:hidden">{latest.replace(/\*\*/g, "")}</p>}
      <div className="md mt-2 border-l-2 border-line pl-3">
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
    </details>
  );
}

const EXPIRED = /reconnect spotify/i;

type Segment =
  | { kind: "text"; key: string; text: string }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | { kind: "tools"; key: string; parts: (ToolUIPart | DynamicToolUIPart)[] };

/** Groups an assistant message into text blocks and runs of consecutive tool calls. */
function segments(message: ChatMessage): Segment[] {
  const out: Segment[] = [];
  message.parts.forEach((part, i) => {
    if (part.type === "text" && part.text.trim()) {
      out.push({ kind: "text", key: `${message.id}-${i}`, text: part.text });
    } else if (part.type === "reasoning" && part.text.trim()) {
      const last = out.at(-1);
      // Merge consecutive thought chunks into one block.
      if (last?.kind === "reasoning") {
        last.text += `\n\n${part.text}`;
        last.streaming = part.state === "streaming";
      } else {
        out.push({ kind: "reasoning", key: `${message.id}-${i}`, text: part.text, streaming: part.state === "streaming" });
      }
    } else if (isToolUIPart(part)) {
      const last = out.at(-1);
      if (last?.kind === "tools") last.parts.push(part);
      else out.push({ kind: "tools", key: `${message.id}-${i}`, parts: [part] });
    }
  });
  return out;
}

/** Non-2xx responses from /api/chat arrive as the raw JSON body `{"error": "..."}`. */
function readableError(message: string): string {
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed?.error === "string") return parsed.error;
  } catch {
    // plain text
  }
  return message || "The response failed.";
}

function finalPlaylist(part: ToolUIPart | DynamicToolUIPart) {
  if (part.state !== "output-available" || part.preliminary) return null;
  const playlist = (part.output as ToolOutputView | undefined)?.playlist;
  return isPlaylistCard(playlist) ? playlist : null;
}

export function Chat({
  user,
  settings,
  onSettingsChange,
  onDisconnect,
  onReconnect,
}: {
  user: { name: string; image: string | null };
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}) {
  const [input, setInput] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [lang, setLang] = useState<"en" | "pt">("en");
  const [transport] = useState(() => new DefaultChatTransport<ChatMessage>({ api: "/api/chat" }));
  const [live, setLive] = useState<ModelStatus | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const { messages, sendMessage, status, stop, error, regenerate } = useChat<ChatMessage>({
    transport,
    onData: (part) => {
      if (part.type === "data-status") setLive(part.data);
    },
    onFinish: ({ message }) => {
      if (message.metadata?.modelRef) writeJson(LAST_MODEL_KEY, message.metadata.modelRef);
    },
  });

  const [mode, setModeState] = useState<Mode>("quick");
  const setMode = (next: Mode) => {
    setModeState(next);
    writeJson(MODE_KEY, next);
  };

  useEffect(() => {
    if (navigator.language.toLowerCase().startsWith("pt")) setLang("pt");
    if (readJson<Mode>(MODE_KEY) === "agent") setModeState("agent");
  }, []);
  const endRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  /** Per-request credentials: a fresh Spotify token and the user's own AI key. */
  const requestBody = async (requestMode: Mode = mode) => {
    let spotifyToken: string | null = null;
    try {
      spotifyToken = await getAccessToken();
    } catch {
      setLocalError("Couldn't reach Spotify to refresh your connection. Check your network and try again.");
      return null;
    }
    if (!spotifyToken) {
      setLocalError("Your Spotify connection expired. Reconnect Spotify to continue.");
      return null;
    }
    setLocalError(null);
    return { keys: settings.keys, spotifyToken, preferredModel: readJson<ModelRef>(LAST_MODEL_KEY), mode: requestMode };
  };

  const send = async (text: string, requestMode: Mode = mode) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (requestMode !== mode) setMode(requestMode);
    const body = await requestBody(requestMode);
    if (!body) return;
    setInput("");
    setLive(null);
    setStartedAt(Date.now());
    void sendMessage({ text: trimmed }, { body });
  };

  const retry = async () => {
    const body = await requestBody();
    if (!body) return;
    setLive(null);
    setStartedAt(Date.now());
    void regenerate({ body });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const lastId = messages.at(-1)?.id;
  const errorText = localError ?? (error ? readableError(error.message) : null);
  const expired = !!errorText && EXPIRED.test(errorText);

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <p className="font-display mr-auto text-lg font-semibold tracking-tight">Crate</p>

          <button type="button" onClick={() => settingsRef.current?.showModal()} className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
            Settings
          </button>

          <div className="flex items-center gap-2">
            {user.image ? (
              <Image src={user.image} alt="" width={28} height={28} className="size-7 rounded-full object-cover" />
            ) : (
              <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-ultra-soft text-xs font-semibold text-ultra-deep">
                {(user.name || "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <button type="button" onClick={onDisconnect} className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
              Disconnect
            </button>
          </div>
        </div>
      </header>

      <dialog
        ref={settingsRef}
        aria-label="Settings"
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl bg-paper p-6 text-ink shadow-2xl backdrop:bg-ink/40 sm:p-8"
      >
        <h2 className="font-display mb-6 text-2xl font-bold tracking-tight">Settings</h2>
        <SettingsForm
          key={JSON.stringify(settings)}
          initial={settings}
          submitLabel="Save settings"
          onSubmit={(next) => {
            settingsRef.current?.close();
            onSettingsChange(next);
          }}
          onCancel={() => settingsRef.current?.close()}
        />
      </dialog>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          {messages.length === 0 && (
            <section className="pt-[8vh]">
              <h1 className="font-display text-4xl leading-tight font-bold tracking-tight text-balance sm:text-5xl">
                What should we make{user.name ? `, ${user.name.split(" ")[0]}` : ""}?
              </h1>
              <p className="mt-3 text-muted">Describe a new playlist, or tell Crate what to change in one you have.</p>
              <ul className="mt-8 grid gap-2 sm:grid-cols-2">
                {EXAMPLES[lang].map((example) => (
                  <li key={example.text}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void send(example.text, example.mode)}
                      className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-line bg-panel/60 px-4 py-3 text-left text-[0.95rem] transition-colors hover:border-ultra hover:bg-panel disabled:opacity-50"
                    >
                      <span>{example.text}</span>
                      <span className="text-xs text-muted">{MODES[example.mode].label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="space-y-6">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-ultra px-4 py-3 whitespace-pre-wrap text-white">
                  {message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
                </div>
              ) : (
                <div key={message.id} className="space-y-4">
                  {segments(message).map((seg) =>
                    seg.kind === "reasoning" ? (
                      <Thoughts key={seg.key} text={seg.text} streaming={seg.streaming && busy && message.id === lastId} />
                    ) : seg.kind === "text" ? (
                      <div key={seg.key} className="md max-w-[68ch]">
                        <ReactMarkdown components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}>
                          {seg.text}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div key={seg.key} className="space-y-4">
                        <ol aria-label="Agent steps" className="border-l-2 border-line pl-4">
                          {seg.parts.map((part) => (
                            <ToolStep key={part.toolCallId} part={part} interrupted={!busy || message.id !== lastId} />
                          ))}
                        </ol>
                        {seg.parts.map((part) => {
                          const card = finalPlaylist(part);
                          return card ? <PlaylistCard key={`card-${part.toolCallId}`} data={card} /> : null;
                        })}
                      </div>
                    ),
                  )}
                  {message.metadata?.model && (
                    <div className="space-y-0.5 text-xs text-muted">
                      {message.metadata.switches?.map((s) => (
                        <p key={s}>{s}</p>
                      ))}
                      {message.metadata.warnings?.map((w) => (
                        <p key={w} className="text-danger">
                          {w}
                        </p>
                      ))}
                      <p>Answered by {message.metadata.model}</p>
                    </div>
                  )}
                </div>
              ),
            )}

            {busy && <LiveStatus status={live} startedAt={startedAt || Date.now()} />}

            {errorText && (
              <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-danger">
                <p>{errorText}</p>
                <div className="mt-2 flex gap-4 font-semibold">
                  {expired ? (
                    <button type="button" onClick={onReconnect} className="underline underline-offset-2">
                      Reconnect Spotify
                    </button>
                  ) : (
                    error && (
                      <button type="button" onClick={() => void retry()} className="underline underline-offset-2">
                        Try again
                      </button>
                    )
                  )}
                  {/api key|settings/i.test(errorText) && (
                    <button type="button" onClick={() => settingsRef.current?.showModal()} className="underline underline-offset-2">
                      Open settings
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          <div ref={endRef} />
        </div>
      </main>

      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
          <div role="radiogroup" aria-label="Mode" className="flex rounded-full bg-panel p-0.5 text-sm shadow-[0_0_0_1px_var(--color-line)]">
            {(Object.keys(MODES) as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={busy}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 font-medium transition-colors disabled:opacity-60 ${
                  mode === m ? "bg-ink text-white" : "text-muted hover:text-ink"
                }`}
              >
                {MODES[m].label}
              </button>
            ))}
          </div>
          <p className="min-w-0 flex-1 text-xs text-muted">{MODES[mode].hint[lang]}</p>
        </div>
        <form onSubmit={onSubmit} className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-3">
          <label htmlFor="prompt" className="sr-only">
            Describe what you want
          </label>
          <textarea
            id="prompt"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              lang === "pt"
                ? "ex.: Tire da Viagem as músicas que eu nunca ouço e adicione lançamentos dos meus artistas favoritos"
                : "e.g. Remove songs I never play from Road Trip and add new releases from my top artists"
            }
            className="max-h-48 min-h-[3.25rem] flex-1 resize-y rounded-xl border border-line bg-panel px-4 py-3 placeholder:text-muted/80 focus:border-ultra focus:outline-none"
          />
          {busy ? (
            <button type="button" onClick={() => void stop()} className="h-[3.25rem] rounded-xl border border-ink px-5 font-semibold">
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="h-[3.25rem] rounded-xl bg-ultra px-5 font-semibold text-white transition-colors hover:bg-ultra-deep disabled:opacity-40"
            >
              Send
            </button>
          )}
        </form>
      </footer>
    </div>
  );
}
