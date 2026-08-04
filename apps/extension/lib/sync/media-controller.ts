import { browser } from "wxt/browser";
import { DriftController } from "@vyzync/sync-core";

import { isRuntimeResponse, makeRequestId, sendRuntimeRequest } from "../bridge";
import { compatibilityNoticeFor } from "../compatibility-notice";
import { RuntimeEventSchema } from "../runtime-schema";
import { compareVideoIdentities } from "../adapters/identity";
import { createMediaAdapter, type MediaAdapter } from "../adapters/media-adapter";
import { PlayerDetector } from "../adapters/player-detector";
import { StatusBadge, type StatusBadgeIconUrls } from "../badge";
import type {
  LocalMediaAction,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
  RoomView,
  SyncStatus,
  ThemeMode,
  VideoSnapshot,
} from "../types";

const SNAPSHOT_INTERVAL_MS = 2_500;
const BUFFER_BARRIER_MS = 1_500;
const RATE_NUDGE_DURATION_MS = 3_000;

type MediaEventKind = "play" | "pause" | "seek" | "rate";

interface Suppression {
  commandId: string;
  kind: MediaEventKind;
  until: number;
  expectedPosition?: number;
  expectedRate?: number;
}

interface MediaSessionControllerOptions {
  showBadge: boolean;
  themeMode: ThemeMode;
  badgeIcons: StatusBadgeIconUrls;
  onDestroy?: () => void;
}

function response<T>(promise: Promise<T>, sendResponse: (value: RuntimeResponse<T>) => void): void {
  void promise.then(
    (data) => sendResponse({ ok: true, requestId: "content", data }),
    (error: unknown) =>
      sendResponse({
        ok: false,
        requestId: "content",
        error: error instanceof Error ? error.message : "Content script error.",
      }),
  );
}

export class MediaSessionController {
  private readonly detector: PlayerDetector;
  private readonly driftController = new DriftController();
  private readonly suppressions = new Map<string, Suppression>();
  private adapter?: MediaAdapter;
  private badge?: StatusBadge;
  private roomActive = false;
  private buffering = false;
  private bufferTimer?: number;
  private snapshotTimer?: number;
  private lastSnapshot?: VideoSnapshot;
  private destroyed = false;
  private localCanControl = false;
  private barrierHolding = false;
  private initialSyncPending = false;
  private badgeStatus: SyncStatus = "ready";
  private badgeDetail?: string;
  private badgeRoom?: RoomView;
  private runtimeListener?: Parameters<typeof browser.runtime.onMessage.addListener>[0];
  private readonly boundListeners: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [];
  private readonly onLocationChange = (): void => this.handlePlayersChanged();
  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) this.destroy();
  };
  private readonly onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.handlePlayersChanged();
  };

  constructor(private readonly options: MediaSessionControllerOptions) {
    this.detector = new PlayerDetector(() => this.handlePlayersChanged());
    this.setBadgeAppearance(options.showBadge, options.themeMode);
  }

  setBadgeAppearance(showBadge: boolean, themeMode: ThemeMode): void {
    if (!showBadge) {
      this.badge?.destroy();
      this.badge = undefined;
      return;
    }
    this.badge ??= new StatusBadge(themeMode, this.options.badgeIcons, {
      onCopyRoomCode: (roomCode) => this.copyRoomCode(roomCode),
      onReconnect: () => this.reconnectRoom(),
      onLeaveRoom: (endRoom) => this.leaveRoom(endRoom),
    });
    this.badge.setThemeMode(themeMode);
    this.badge.update(this.badgeStatus, this.badgeDetail, this.badgeRoom);
  }

  start(): void {
    this.detector.start();
    this.handlePlayersChanged();
    this.runtimeListener = (message, _sender, sendResponse) => {
      const parsed = RuntimeEventSchema.safeParse(message);
      if (!parsed.success) return false;
      response(this.handleRuntimeEvent(parsed.data), sendResponse);
      return true;
    };
    browser.runtime.onMessage.addListener(this.runtimeListener);
    window.addEventListener("pagehide", this.onPageHide, { once: true });
    window.addEventListener("pageshow", this.onPageShow);
    window.addEventListener("wxt:locationchange", this.onLocationChange);
    void this.send({
      type: "content/hello",
      requestId: makeRequestId(),
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unbindAdapter();
    this.detector.stop();
    this.badge?.destroy();
    if (this.runtimeListener) {
      browser.runtime.onMessage.removeListener(this.runtimeListener);
      this.runtimeListener = undefined;
    }
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("wxt:locationchange", this.onLocationChange);
    if (this.snapshotTimer) window.clearInterval(this.snapshotTimer);
    if (this.bufferTimer) window.clearTimeout(this.bufferTimer);
    this.options.onDestroy?.();
  }

  private handlePlayersChanged(): void {
    const next = this.detector.selectedElement();
    if (next !== this.adapter?.element) {
      this.unbindAdapter();
      if (next) {
        this.adapter = createMediaAdapter(next);
        this.bindAdapter();
      }
    }
    this.publishSnapshot();
  }

  private bindAdapter(): void {
    const events: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [
      ["play", () => this.publishAction("play")],
      ["pause", () => this.publishAction("pause")],
      ["seeked", () => this.publishAction("seek")],
      ["ratechange", () => this.publishAction("rate")],
      ["waiting", () => this.handleWaiting()],
      ["stalled", () => this.handleWaiting()],
      ["playing", () => this.handleCanPlay()],
      ["canplay", () => this.handleCanPlay()],
      ["ended", () => this.publishAction("ended")],
      ["loadedmetadata", () => this.publishSnapshot()],
      ["durationchange", () => this.publishSnapshot()],
    ];
    this.boundListeners.push(...events);
    events.forEach(([name, listener]) => this.adapter?.element.addEventListener(name, listener));
  }

  private unbindAdapter(): void {
    if (this.adapter) {
      this.boundListeners.forEach(([name, listener]) =>
        this.adapter?.element.removeEventListener(name, listener),
      );
      this.adapter.destroy();
    }
    this.boundListeners.length = 0;
    this.adapter = undefined;
  }

  private handleWaiting(): void {
    if (this.bufferTimer) return;
    this.bufferTimer = window.setTimeout(() => {
      this.bufferTimer = undefined;
      this.buffering = true;
      this.publishAction("waiting");
      this.publishSnapshot();
    }, BUFFER_BARRIER_MS);
  }

  private handleCanPlay(): void {
    if (this.bufferTimer) {
      window.clearTimeout(this.bufferTimer);
      this.bufferTimer = undefined;
    }
    if (!this.buffering) return;
    this.buffering = false;
    this.publishAction("can-play");
    this.publishSnapshot();
  }

  private publishAction(kind: LocalMediaAction["kind"]): void {
    if (!this.adapter || !this.roomActive) return;
    if (
      !this.localCanControl &&
      (kind === "play" || kind === "pause" || kind === "seek" || kind === "rate")
    ) {
      return;
    }
    if (
      (kind === "play" || kind === "pause" || kind === "seek" || kind === "rate") &&
      this.isSuppressed(kind)
    ) {
      return;
    }
    const action: LocalMediaAction = {
      kind,
      positionSeconds: this.adapter.element.currentTime,
      playbackRate: this.adapter.element.playbackRate,
    };
    void this.send({ type: "content/action", requestId: makeRequestId(), action });
  }

  private publishSnapshot(): void {
    const candidates = this.detector.summaries();
    this.lastSnapshot = this.adapter?.snapshot(this.buffering);
    if (!this.roomActive) {
      const notice = compatibilityNoticeFor({
        enabled: true,
        supportedPage: true,
        ...(this.lastSnapshot ? { video: this.lastSnapshot } : {}),
        candidates,
      });
      if (notice?.kind === "unsupported-player") {
        this.updateBadge("no-video", notice.message);
      } else if (notice) {
        this.updateBadge("ready", `${notice.title}. ${notice.message}`);
      } else {
        this.updateBadge("ready");
      }
    }
    void this.send({
      type: "content/snapshot",
      requestId: makeRequestId(),
      snapshot:
        this.lastSnapshot ??
        ({
          identity: {
            provider: "none",
            contentKey: "none",
            origin: location.origin,
            pathFingerprint: "none",
            titleFingerprint: "none",
            displayTitle: "No supported video",
            durationMs: null,
            isLive: false,
            seekable: false,
          },
          positionSeconds: 0,
          durationSeconds: null,
          paused: true,
          playbackRate: 1,
          readyState: 0,
          buffering: false,
          ended: false,
          adState: "unknown",
          capabilities: {
            canPlay: false,
            canPause: false,
            canSeek: false,
            canSetRate: false,
            isLive: false,
          },
          capturedAt: Date.now(),
        } satisfies VideoSnapshot),
      candidates,
    });
  }

  private startSnapshots(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = window.setInterval(() => {
      if (this.roomActive && !document.hidden) this.publishSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  private stopSnapshots(): void {
    if (!this.snapshotTimer) return;
    window.clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
  }

  private async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    switch (event.type) {
      case "background/room-state":
        if (!this.roomActive && event.room.participantCount > 0) {
          this.initialSyncPending = true;
        }
        this.roomActive = event.room.participantCount > 0;
        this.badgeRoom = event.room;
        this.localCanControl = event.room.role === "host" || event.room.controlMode === "shared";
        if (this.roomActive) this.startSnapshots();
        else this.stopSnapshots();
        this.updateBadge(event.room.status, event.room.message);
        break;
      case "background/remote-command":
        await this.applyRemoteCommand(event.command);
        break;
      case "background/authoritative-snapshot":
        await this.correctFromSnapshot(event.snapshot, event.commandId);
        break;
      case "background/select-video":
        this.detector.select(event.candidateId);
        break;
      case "background/status":
        this.updateBadge(event.status, event.message);
        break;
      case "background/request-snapshot":
        this.publishSnapshot();
        break;
      case "background/user-ready":
        if (this.adapter) {
          const result = await this.adapter.play();
          if (result === "playing") {
            this.suppress("ready:pause", "pause", 1_200);
            this.adapter.pause();
          }
          await this.send({
            type: "content/ready-state",
            requestId: makeRequestId(),
            autoplayUnlocked: result === "playing",
          });
          this.publishSnapshot();
        }
        break;
      case "background/deactivate":
        this.destroy();
        break;
    }
  }

  private async applyRemoteCommand(command: {
    commandId: string;
    kind: MediaEventKind;
    positionSeconds: number;
    playbackRate: number;
  }): Promise<void> {
    if (!this.adapter || this.suppressions.has(command.commandId)) return;
    if (command.commandId.startsWith("barrier-")) this.barrierHolding = true;
    if (
      command.kind !== "pause" &&
      Math.abs(this.adapter.element.playbackRate - command.playbackRate) > 0.002
    ) {
      this.suppress(`${command.commandId}:rate`, "rate", 1_200, undefined, command.playbackRate);
      this.adapter.setPlaybackRate(command.playbackRate);
    }
    if (
      command.kind === "seek" ||
      Math.abs(this.adapter.element.currentTime - command.positionSeconds) > 1.5
    ) {
      this.suppress(`${command.commandId}:seek`, "seek", 1_500, command.positionSeconds);
      this.adapter.seek(command.positionSeconds);
    }
    if (command.kind === "play") {
      this.suppress(`${command.commandId}:play`, "play", 1_500);
      const result = await this.adapter.play();
      if (result === "blocked") {
        this.updateBadge("autoplay-blocked", "Click Ready in the extension");
        await this.send({ type: "content/autoplay-blocked", requestId: makeRequestId() });
      } else {
        await this.send({
          type: "content/ready-state",
          requestId: makeRequestId(),
          autoplayUnlocked: true,
        });
      }
    } else if (command.kind === "pause") {
      this.suppress(`${command.commandId}:pause`, "pause", 1_200);
      this.adapter.pause();
    }
    this.pruneSuppressions();
  }

  private async correctFromSnapshot(remote: VideoSnapshot, commandId: string): Promise<void> {
    if (!this.adapter) return;
    const local = this.adapter.snapshot(this.buffering);
    const comparison = compareVideoIdentities(local.identity, remote.identity);
    if (!comparison.compatible) {
      this.driftController.reset();
      this.updateBadge("mismatch", comparison.reason);
      await this.send({
        type: "content/mismatch",
        requestId: makeRequestId(),
        local: local.identity,
        remote: remote.identity,
        reason: comparison.reason ?? "Video mismatch",
      });
      return;
    }
    if (local.buffering || remote.buffering) {
      this.driftController.reset();
      this.updateBadge("peer-buffering", "Holding until both players are ready");
      if (!local.paused) {
        this.barrierHolding = true;
        this.suppress(`${commandId}:barrier`, "pause", 1_200);
        this.adapter.pause();
      }
      return;
    }
    const expected =
      remote.paused || remote.ended
        ? remote.positionSeconds
        : remote.positionSeconds +
          Math.max(0, (Date.now() - remote.capturedAt) / 1_000) * remote.playbackRate;
    const drift = expected - local.positionSeconds;
    const magnitude = Math.abs(drift);

    if (this.barrierHolding || this.initialSyncPending) {
      const recoveringFromBarrier = this.barrierHolding;
      this.barrierHolding = false;
      this.initialSyncPending = false;
      this.driftController.reset();
      if (Math.abs(this.adapter.element.playbackRate - remote.playbackRate) > 0.002) {
        this.suppress(`${commandId}:barrier-rate`, "rate", 1_200, undefined, remote.playbackRate);
        this.adapter.setPlaybackRate(remote.playbackRate);
      }
      if (local.capabilities.canSeek && magnitude > 0.1) {
        this.suppress(`${commandId}:barrier-seek`, "seek", 1_500, expected);
        this.adapter.seek(expected);
      }
      if (remote.paused || remote.ended) {
        if (!this.adapter.element.paused) {
          this.suppress(`${commandId}:barrier-pause`, "pause", 1_200);
          this.adapter.pause();
        }
      } else if (this.adapter.element.paused) {
        this.suppress(`${commandId}:barrier-play`, "play", 1_500);
        const result = await this.adapter.play();
        if (result === "blocked") {
          this.updateBadge("autoplay-blocked", "Click Ready in the extension");
          await this.send({ type: "content/autoplay-blocked", requestId: makeRequestId() });
          return;
        }
      }
      this.updateBadge(
        "correcting",
        recoveringFromBarrier ? "Resynchronized after buffering" : "Initial synchronization",
      );
      return;
    }

    if (remote.ended || remote.paused) {
      if (!local.paused) {
        this.suppress(`${commandId}:pause`, "pause", 1_200);
        this.adapter.pause();
      }
    } else if (local.paused) {
      this.suppress(`${commandId}:play`, "play", 1_500);
      const result = await this.adapter.play();
      if (result === "blocked") {
        this.updateBadge("autoplay-blocked", "Click Ready in the extension");
        await this.send({ type: "content/autoplay-blocked", requestId: makeRequestId() });
        return;
      }
    }

    const decision = this.driftController.decide({
      nowMs: performance.now(),
      expectedPositionSec: expected,
      actualPositionSec: this.adapter.element.currentTime,
      selectedPlaybackRate: remote.playbackRate,
      actualPlaybackRate: this.adapter.element.playbackRate,
      paused: remote.paused || remote.ended,
      canSeek: local.capabilities.canSeek,
      synchronizationAllowed: comparison.compatible,
      isBuffering: local.buffering || remote.buffering,
      isAdvertisement: this.adapter.isAdvertisement() || remote.adState === "ad",
    });
    switch (decision.type) {
      case "none":
        this.updateBadge(
          magnitude <= 0.1 ? "in-sync" : "correcting",
          `${Math.round(magnitude * 1_000)} ms`,
        );
        break;
      case "seek":
        this.suppress(commandId, "seek", 1_500, decision.positionSec);
        this.adapter.seek(decision.positionSec);
        if (Math.abs(this.adapter.element.playbackRate - decision.playbackRate) > 0.002) {
          this.suppress(`${commandId}:seek-rate`, "rate", 1_200, undefined, decision.playbackRate);
          this.adapter.setPlaybackRate(decision.playbackRate);
        }
        this.updateBadge("correcting", `seeking ${Math.round(drift * 1_000)} ms`);
        break;
      case "adjust-rate":
        this.suppress(
          `${commandId}:rate`,
          "rate",
          RATE_NUDGE_DURATION_MS + 500,
          undefined,
          decision.playbackRate,
        );
        this.adapter.setPlaybackRate(decision.playbackRate);
        this.updateBadge("correcting", `nudging ${Math.round(drift * 1_000)} ms`);
        break;
      case "restore-rate":
        this.suppress(`${commandId}:restore`, "rate", 1_000, undefined, decision.playbackRate);
        this.adapter.setPlaybackRate(decision.playbackRate);
        this.updateBadge("in-sync", `${Math.round(magnitude * 1_000)} ms`);
        break;
    }
  }

  private isSuppressed(kind: MediaEventKind): boolean {
    const now = performance.now();
    for (const suppression of this.suppressions.values()) {
      if (suppression.until < now) continue;
      if (suppression.kind !== kind) continue;
      if (
        kind === "seek" &&
        suppression.expectedPosition !== undefined &&
        this.adapter &&
        Math.abs(this.adapter.element.currentTime - suppression.expectedPosition) > 0.35
      ) {
        continue;
      }
      if (
        kind === "rate" &&
        suppression.expectedRate !== undefined &&
        this.adapter &&
        Math.abs(this.adapter.element.playbackRate - suppression.expectedRate) > 0.01
      ) {
        continue;
      }
      return true;
    }
    this.pruneSuppressions();
    return false;
  }

  private suppress(
    commandId: string,
    kind: MediaEventKind,
    durationMs: number,
    expectedPosition?: number,
    expectedRate?: number,
  ): void {
    this.suppressions.set(commandId, {
      commandId,
      kind,
      until: performance.now() + durationMs,
      expectedPosition,
      expectedRate,
    });
  }

  private pruneSuppressions(): void {
    const now = performance.now();
    for (const [id, suppression] of this.suppressions) {
      if (suppression.until < now) this.suppressions.delete(id);
    }
  }

  private updateBadge(status: SyncStatus, message?: string): void {
    this.badgeStatus = status;
    this.badgeDetail = message;
    this.badge?.update(status, message, this.badgeRoom);
  }

  private async copyRoomCode(roomCode: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomCode);
        return;
      }
    } catch {
      // Fall through to the user-gesture copy path for browsers that restrict Clipboard API access.
    }

    const textArea = document.createElement("textarea");
    textArea.value = roomCode;
    textArea.setAttribute("readonly", "");
    textArea.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.documentElement.append(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();
    if (!copied) throw new Error("Could not copy the room code.");
  }

  private async reconnectRoom(): Promise<void> {
    await sendRuntimeRequest<RoomView>({ type: "content/reconnect" });
  }

  private async leaveRoom(endRoom: boolean): Promise<void> {
    await sendRuntimeRequest<RoomView>({ type: "content/leave-room", endRoom });
  }

  private async send<T>(message: RuntimeRequest): Promise<T | undefined> {
    try {
      const reply: unknown = await browser.runtime.sendMessage(message);
      return isRuntimeResponse(reply) ? (reply.data as T | undefined) : undefined;
    } catch {
      this.updateBadge("offline", "Extension context unavailable");
      return undefined;
    }
  }
}
