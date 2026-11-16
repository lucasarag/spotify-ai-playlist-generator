import type { ProviderId } from "./providers";

/** Output shapes shared by the server tools and the client UI. */

export interface ToolProgress {
  status: "running";
  message: string;
}

export interface PlaylistCardData {
  id: string;
  name: string;
  url: string;
  imageUrl: string | null;
  total: number | null;
  added: number;
  removed: number;
  skippedDuplicates?: number;
  sample: { name: string; artists: string }[];
}

/** Sent with each assistant message: which model answered and any automatic switches. */
export interface ModelRef {
  provider: ProviderId;
  modelId: string;
}

export interface ChatMetadata {
  model?: string;
  /** The model that produced this answer; the client sends it back as the preferred model. */
  modelRef?: ModelRef;
  switches?: string[];
  warnings?: string[];
}

/** Live, transient progress from the model layer (streamed as `data-status` parts). */
export type ModelStatus =
  | { phase: "connecting"; model: string }
  | { phase: "busy"; model: string; reason: string }
  | { phase: "working"; model: string; firstChunkMs: number }
  | { phase: "waiting"; seconds: number };

export type ChatDataParts = { status: ModelStatus };

/** Loose view of any tool output, as read by the UI. */
export interface ToolOutputView {
  status?: "running" | "done";
  message?: string;
  playlist?: PlaylistCardData | Record<string, unknown>;
}

export function isPlaylistCard(value: unknown): value is PlaylistCardData {
  return !!value && typeof value === "object" && "sample" in value && "url" in value && "added" in value;
}
