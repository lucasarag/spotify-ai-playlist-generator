"use client";

import { type DynamicToolUIPart, type ToolUIPart, getToolName } from "ai";
import type { ToolOutputView } from "@/lib/ai/tool-output";

const STARTING: Record<string, string> = {
  generateSongList: "Asking the AI for song ideas",
  getUserPlaylists: "Loading your playlists",
  getPlaylistTracks: "Reading playlist tracks",
  searchTracks: "Searching Spotify",
  getUserListeningStats: "Analyzing your listening history",
  getArtistsLatestReleases: "Checking new releases",
  createPlaylist: "Creating playlist",
  updatePlaylistTracks: "Updating playlist",
};

export function Equalizer({ label }: { label?: string }) {
  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="flex h-3.5 w-3.5 shrink-0 items-end justify-center gap-[2px]">
      <span className="eq-bar h-3.5 w-[3px] rounded-sm bg-flare" />
      <span className="eq-bar h-3.5 w-[3px] rounded-sm bg-flare" />
      <span className="eq-bar h-3.5 w-[3px] rounded-sm bg-flare" />
    </span>
  );
}

type StepState = "running" | "done" | "error" | "skipped";

function describe(part: ToolUIPart | DynamicToolUIPart): { state: StepState; text: string } {
  const name = getToolName(part);
  const starting = `${STARTING[name] ?? name}…`;
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return { state: "running", text: starting };
    case "output-available": {
      const out = (part.output ?? {}) as ToolOutputView;
      const running = part.preliminary || out.status === "running";
      return { state: running ? "running" : "done", text: out.message ?? starting };
    }
    case "output-error":
      return { state: "error", text: part.errorText ?? "This step failed." };
    default:
      return { state: "skipped", text: `${STARTING[name] ?? name} was skipped` };
  }
}

export function ToolStep({ part, interrupted }: { part: ToolUIPart | DynamicToolUIPart; interrupted: boolean }) {
  let { state, text } = describe(part);
  if (state === "running" && interrupted) {
    state = "skipped";
    text = `${text.replace(/…$/, "")} (stopped)`;
  }

  return (
    <li className="flex items-start gap-3 py-1 text-sm">
      <span className="mt-[5px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {state === "running" && <Equalizer />}
        {state === "done" && <span className="size-2.5 rounded-full bg-ok" />}
        {state === "error" && <span className="size-2.5 rotate-45 rounded-[2px] bg-danger" />}
        {state === "skipped" && <span className="size-2.5 rounded-full border-2 border-line" />}
      </span>
      <span
        aria-live={state === "running" ? "polite" : undefined}
        className={
          state === "running" ? "font-medium text-ink" : state === "error" ? "text-danger" : "text-muted"
        }
      >
        {text}
      </span>
    </li>
  );
}
