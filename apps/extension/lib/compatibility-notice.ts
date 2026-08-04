import type { PopupState } from "./types";

export type CompatibilityNoticeKind =
  | "live-video"
  | "multiple-videos"
  | "seeking-unavailable"
  | "unsupported-page"
  | "unsupported-player";

export interface CompatibilityNotice {
  kind: CompatibilityNoticeKind;
  message: string;
  title: string;
  tone: "negative" | "warning";
}

type CompatibilityState = Pick<PopupState, "candidates" | "enabled" | "supportedPage" | "video">;

export function compatibilityNoticeFor(state: CompatibilityState): CompatibilityNotice | undefined {
  if (!state.supportedPage) {
    return {
      kind: "unsupported-page",
      title: "This page isn’t supported",
      message: "Open a regular video page and try again.",
      tone: "negative",
    };
  }

  if (!state.enabled) return undefined;

  if (!state.video?.capabilities.canPlay) {
    return {
      kind: "unsupported-player",
      title: "This player isn’t supported",
      message: "Try another video or site.",
      tone: "negative",
    };
  }

  if (state.candidates.length > 1) {
    return {
      kind: "multiple-videos",
      title: "Multiple videos detected",
      message: "The main video is selected. Choose another if needed.",
      tone: "warning",
    };
  }

  if (state.video.identity.isLive) {
    return {
      kind: "live-video",
      title: "Live video has limited support",
      message: "Play and pause can sync, but timing may vary.",
      tone: "warning",
    };
  }

  if (!state.video.capabilities.canSeek) {
    return {
      kind: "seeking-unavailable",
      title: "Seeking isn’t supported",
      message: "Play and pause can still sync.",
      tone: "warning",
    };
  }

  return undefined;
}
