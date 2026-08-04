import { describe, expect, it } from "vitest";

import { compatibilityNoticeFor } from "../lib/compatibility-notice";
import type { PopupState, VideoSnapshot } from "../lib/types";

const playableVideo: VideoSnapshot = {
  identity: {
    provider: "youtube",
    contentKey: "video-id",
    origin: "https://www.youtube.com",
    pathFingerprint: "watch",
    titleFingerprint: "example-video",
    displayTitle: "Example video",
    durationMs: 120_000,
    isLive: false,
    seekable: true,
  },
  positionSeconds: 0,
  durationSeconds: 120,
  paused: true,
  playbackRate: 1,
  readyState: 4,
  buffering: false,
  ended: false,
  adState: "content",
  capabilities: {
    canPlay: true,
    canPause: true,
    canSeek: true,
    canSetRate: true,
    isLive: false,
  },
  capturedAt: 1,
};

function state(overrides: Partial<PopupState> = {}): PopupState {
  return {
    enabled: true,
    supportedPage: true,
    video: playableVideo,
    candidates: [
      { id: "video-1", label: "Video", score: 100, width: 1280, height: 720, selected: true },
    ],
    room: {
      participantCount: 0,
      controlMode: "host-only",
      status: "ready",
      message: "Ready.",
    },
    ...overrides,
  };
}

describe("compatibility notices", () => {
  it("uses plain copy when several videos are available", () => {
    const notice = compatibilityNoticeFor(
      state({
        candidates: [
          { id: "video-1", label: "Main", score: 100, width: 1280, height: 720, selected: true },
          { id: "video-2", label: "Preview", score: 20, width: 320, height: 180, selected: false },
        ],
      }),
    );

    expect(notice).toEqual({
      kind: "multiple-videos",
      title: "Multiple videos detected",
      message: "The main video is selected. Choose another if needed.",
      tone: "warning",
    });
  });

  it("uses a simple unsupported-player message instead of diagnostics", () => {
    const notice = compatibilityNoticeFor(
      state({
        video: {
          ...playableVideo,
          capabilities: { ...playableVideo.capabilities, canPlay: false },
        },
        candidates: [],
      }),
    );

    expect(notice).toEqual({
      kind: "unsupported-player",
      title: "This player isn’t supported",
      message: "Try another video or site.",
      tone: "negative",
    });
  });

  it("explains unsupported browser pages without exposing an error", () => {
    expect(
      compatibilityNoticeFor(
        state({ enabled: false, supportedPage: false, video: undefined, candidates: [] }),
      ),
    ).toMatchObject({
      kind: "unsupported-page",
      title: "This page isn’t supported",
      message: "Open a regular video page and try again.",
    });
  });

  it("keeps permission requests and fully supported videos free of extra notices", () => {
    expect(compatibilityNoticeFor(state({ enabled: false }))).toBeUndefined();
    expect(compatibilityNoticeFor(state())).toBeUndefined();
  });

  it("uses plain limited-support messages for live and non-seekable video", () => {
    expect(
      compatibilityNoticeFor(
        state({
          video: {
            ...playableVideo,
            identity: { ...playableVideo.identity, isLive: true },
          },
        }),
      ),
    ).toMatchObject({
      title: "Live video has limited support",
      message: "Play and pause can sync, but timing may vary.",
    });

    expect(
      compatibilityNoticeFor(
        state({
          video: {
            ...playableVideo,
            capabilities: { ...playableVideo.capabilities, canSeek: false },
          },
        }),
      ),
    ).toMatchObject({
      title: "Seeking isn’t supported",
      message: "Play and pause can still sync.",
    });
  });
});
