import type { SafeVideoIdentity, VideoSnapshot } from "../types";
import { deriveVideoIdentity } from "./identity";

export interface MediaAdapter {
  readonly element: HTMLVideoElement;
  readonly provider: string;
  identity(): SafeVideoIdentity;
  snapshot(buffering: boolean): VideoSnapshot;
  play(): Promise<"playing" | "blocked">;
  pause(): void;
  seek(positionSeconds: number): void;
  setPlaybackRate(rate: number): void;
  isAdvertisement(): boolean;
  destroy(): void;
}

function detectedAd(element: HTMLVideoElement): boolean {
  const markers = [
    "[class*='ad-showing']",
    "[class*='advertisement']",
    "[data-testid*='ad-']",
    "[aria-label*='Advertisement' i]",
  ];
  return markers.some((selector) => element.closest(selector) !== null);
}

function providerForHost(host: string): string {
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return "youtube";
  if (/(^|\.)vimeo\.com$/.test(host)) return "vimeo";
  if (/(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/.test(host)) return "dailymotion";
  if (/(^|\.)twitch\.tv$/.test(host)) return "twitch-vod";
  if (/(^|\.)netflix\.com$/.test(host)) return "netflix";
  if (/(^|\.)amazon\.[a-z.]+$|(^|\.)primevideo\.com$/.test(host)) return "prime-video";
  if (/(^|\.)disneyplus\.com$/.test(host)) return "disney-plus";
  if (/(^|\.)hulu\.com$/.test(host)) return "hulu";
  if (/(^|\.)max\.com$|(^|\.)hbomax\.com$/.test(host)) return "max";
  if (/(^|\.)peacocktv\.com$/.test(host)) return "peacock";
  if (/(^|\.)paramountplus\.com$/.test(host)) return "paramount-plus";
  if (/(^|\.)tv\.apple\.com$/.test(host)) return "apple-tv-plus";
  if (/(^|\.)crunchyroll\.com$/.test(host)) return "crunchyroll";
  if (/(^|\.)plex\.tv$/.test(host)) return "plex-web";
  return "generic-html5";
}

export class Html5MediaAdapter implements MediaAdapter {
  readonly provider: string;

  constructor(readonly element: HTMLVideoElement) {
    this.provider = providerForHost(location.hostname);
  }

  identity(): SafeVideoIdentity {
    return deriveVideoIdentity({
      url: new URL(location.href),
      title: document.title,
      durationSeconds: this.element.duration,
      seekable: this.element.seekable,
    });
  }

  snapshot(buffering: boolean): VideoSnapshot {
    const identity = this.identity();
    const advertisement = this.isAdvertisement();
    return {
      identity,
      positionSeconds: Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0,
      durationSeconds:
        Number.isFinite(this.element.duration) && this.element.duration > 0
          ? this.element.duration
          : null,
      paused: this.element.paused,
      playbackRate: this.element.playbackRate,
      readyState: this.element.readyState,
      buffering,
      ended: this.element.ended,
      adState: advertisement ? "ad" : this.provider === "generic-html5" ? "unknown" : "content",
      capabilities: {
        canPlay: true,
        canPause: true,
        canSeek: identity.seekable,
        canSetRate: !identity.isLive,
        isLive: identity.isLive,
      },
      capturedAt: Date.now(),
    };
  }

  async play(): Promise<"playing" | "blocked"> {
    try {
      await this.element.play();
      return "playing";
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") return "blocked";
      throw error;
    }
  }

  pause(): void {
    this.element.pause();
  }

  seek(positionSeconds: number): void {
    if (this.element.seekable.length === 0 || !Number.isFinite(positionSeconds)) return;
    const start = this.element.seekable.start(0);
    const end = this.element.seekable.end(this.element.seekable.length - 1);
    this.element.currentTime = Math.min(end, Math.max(start, positionSeconds));
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.element.playbackRate = Math.min(4, Math.max(0.25, rate));
  }

  isAdvertisement(): boolean {
    if (detectedAd(this.element)) return true;
    if (this.provider === "youtube") {
      return document.querySelector(".html5-video-player.ad-showing") !== null;
    }
    return false;
  }

  destroy(): void {
    // Site-specific adapters may release resources here. The generic adapter owns none.
  }
}

export function createMediaAdapter(element: HTMLVideoElement): MediaAdapter {
  return new Html5MediaAdapter(element);
}
