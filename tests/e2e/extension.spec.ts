import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import jsQR from "jsqr";
import { PNG } from "pngjs";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const extensionBrowser = process.env.VYZYNC_E2E_BROWSER ?? "chrome";
if (!new Set(["chrome", "opera"]).has(extensionBrowser)) {
  throw new Error(`Unsupported E2E extension target: ${extensionBrowser}`);
}
const extensionPath = resolve(repositoryRoot, `apps/extension/.output/${extensionBrowser}-mv3-e2e`);
const profilesRoot = resolve(import.meta.dirname, ".profiles");
const browserExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

interface Profile {
  context: BrowserContext;
  fixture: Page;
  popup: Page;
  worker: Worker;
  profilePath: string;
}

interface ExtensionTabsApi {
  tabs: {
    query(queryInfo: { url: string }): Promise<Array<{ id?: number }>>;
  };
}

function decodeQrDataUrl(source: string | null): string | undefined {
  if (!source?.startsWith("data:image/png;base64,")) return undefined;
  const png = PNG.sync.read(Buffer.from(source.slice(source.indexOf(",") + 1), "base64"));
  const pixels = new Uint8ClampedArray(png.data);
  return jsQR(pixels, png.width, png.height)?.data;
}

async function fixtureTabId(worker: Worker, pathname: string): Promise<number> {
  const id = await worker.evaluate(async (pattern) => {
    const api = (globalThis as unknown as { chrome: ExtensionTabsApi }).chrome;
    const tabs = await api.tabs.query({ url: pattern });
    return tabs[0]?.id;
  }, `http://127.0.0.1:4173/${pathname}*`);
  if (id === undefined) throw new Error(`Could not resolve the fixture tab for ${pathname}`);
  return id;
}

async function launchProfile(label: string, pathname = "single.html"): Promise<Profile> {
  await mkdir(profilesRoot, { recursive: true });
  const profilePath = await mkdtemp(join(profilesRoot, `${label}-`));
  const context = await chromium.launchPersistentContext(profilePath, {
    ...(browserExecutablePath
      ? { executablePath: browserExecutablePath }
      : { channel: "chromium" as const }),
    headless: process.env.HEADED !== "1",
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:4173",
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  await worker.evaluate(() => {
    const scope = globalThis as unknown as {
      __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
      __watchSyncSockets?: WebSocket[];
    };
    scope.__watchSyncTelemetry = { inbound: [], outbound: [] };
    scope.__watchSyncSockets = [];
    const jitter = [0, 18, 7, 25, 11];
    let outboundSequence = 0;
    let inboundSequence = 0;
    let outboundReadyAt = 0;
    let inboundReadyAt = 0;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (!scope.__watchSyncSockets?.includes(this)) scope.__watchSyncSockets?.push(this);
      if (typeof data === "string") {
        const parsed = JSON.parse(data) as { type?: string };
        if (parsed.type) scope.__watchSyncTelemetry?.outbound.push(parsed.type);
      }
      const socket = this;
      const delay = 45 + jitter[outboundSequence % jitter.length]!;
      outboundSequence += 1;
      const sendAt = Math.max(Date.now() + delay, outboundReadyAt + 1);
      outboundReadyAt = sendAt;
      setTimeout(
        () => {
          if (socket.readyState === WebSocket.OPEN) originalSend.call(socket, data);
        },
        Math.max(0, sendAt - Date.now()),
      );
    };
    const originalAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== "message") {
        originalAddEventListener.call(this, type, listener, options);
        return;
      }
      const wrapped: EventListener = (event) => {
        const message = event as MessageEvent<unknown>;
        if (typeof message.data === "string") {
          const parsed = JSON.parse(message.data) as { type?: string };
          if (parsed.type) scope.__watchSyncTelemetry?.inbound.push(parsed.type);
        }
        const socket = this;
        const delay = 45 + jitter[inboundSequence % jitter.length]!;
        inboundSequence += 1;
        const deliverAt = Math.max(Date.now() + delay, inboundReadyAt + 1);
        inboundReadyAt = deliverAt;
        setTimeout(
          () => {
            if (typeof listener === "function") listener.call(socket, event);
            else listener.handleEvent(event);
          },
          Math.max(0, deliverAt - Date.now()),
        );
      };
      originalAddEventListener.call(this, type, wrapped, options);
    };
  });
  const extensionId = new URL(worker.url()).hostname;
  const fixture = await context.newPage();
  await fixture.goto(`http://127.0.0.1:4173/${pathname}`);
  await expect
    .poll(() =>
      fixture
        .locator("#main-video")
        .evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);
  const tabId = await fixtureTabId(worker, pathname);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await expect(popup.locator("#status-title")).not.toHaveText("Checking this page…");
  return { context, fixture, popup, worker, profilePath };
}

async function closeProfile(profile: Profile): Promise<void> {
  await profile.context.close();
  const safeRoot = profilesRoot + sep;
  if (!profile.profilePath.startsWith(safeRoot)) {
    throw new Error("Refusing to remove an E2E profile outside the profiles directory");
  }
  await rm(profile.profilePath, { recursive: true, force: true });
}

async function mediaState(page: Page): Promise<{
  paused: boolean;
  currentTime: number;
  playbackRate: number;
}> {
  return page.locator("#main-video").evaluate((element) => {
    const video = element as HTMLVideoElement;
    return {
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
    };
  });
}

async function openVideoTab(profile: Profile, pathname: string): Promise<Page> {
  const page = await profile.context.newPage();
  await page.goto(`http://127.0.0.1:4173/${pathname}`);
  await page.bringToFront();
  await expect
    .poll(() =>
      page.locator("#main-video").evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);
  return page;
}

test("settings support dialog renders real wallet QR codes and copies exact addresses", async () => {
  const profile = await launchProfile("support-dialog");
  try {
    const extensionId = new URL(profile.worker.url()).hostname;
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const options = await profile.context.newPage();
    await options.goto(`${extensionOrigin}/options.html`);
    await options.locator("#theme-dark").check({ force: true });
    await expect(options.locator("html")).toHaveAttribute("data-theme", "dark");

    const supportButton = options.locator("#support-developer");
    await expect(supportButton).toBeEnabled();
    await supportButton.click();
    await expect(options.locator("#support-dialog")).toBeVisible();
    await expect(supportButton).toHaveAttribute("aria-expanded", "true");

    const qr = options.locator("#support-qr");
    await expect(qr).toHaveAttribute("alt", "Bitcoin payment QR code");
    await expect.poll(() => qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    await expect
      .poll(() => qr.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBe(216);
    const bitcoinQr = await qr.getAttribute("src");
    expect(decodeQrDataUrl(bitcoinQr)).toBe("bitcoin:3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87");
    await expect(options.locator("#support-address")).toHaveText(
      "3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87",
    );
    if (process.env.VYZYNC_SUPPORT_SCREENSHOT) {
      await options.screenshot({
        animations: "disabled",
        fullPage: true,
        path: process.env.VYZYNC_SUPPORT_SCREENSHOT,
      });
    }

    await options.locator("#copy-support-address").click();
    await expect(options.locator("#support-status")).toHaveText("Address copied.");
    await expect
      .poll(() => profile.fixture.evaluate(() => navigator.clipboard.readText()))
      .toBe("3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87");

    await options.locator("#support-ethereum").click();
    await expect(options.locator("#support-ethereum")).toHaveAttribute("aria-pressed", "true");
    await expect(options.locator("#support-bitcoin")).toHaveAttribute("aria-pressed", "false");
    await expect(options.locator("#support-address")).toHaveText(
      "0x9B1110fAf0469474a681dba98826a0aeEc7A48B2",
    );
    await expect(qr).toHaveAttribute("alt", "Ethereum payment QR code");
    await expect.poll(() => qr.getAttribute("src")).not.toBe(bitcoinQr);
    expect(decodeQrDataUrl(await qr.getAttribute("src"))).toBe(
      "ethereum:0x9B1110fAf0469474a681dba98826a0aeEc7A48B2@1",
    );

    await expect
      .poll(() =>
        options
          .locator(".support-dialog-panel")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(17, 17, 17)");

    await options.locator("#close-support-dialog").click();
    await expect(options.locator("#support-dialog")).toBeHidden();
    await expect(supportButton).toHaveAttribute("aria-expanded", "false");

    await options.locator("#theme-light").check({ force: true });
    await expect(options.locator("html")).toHaveAttribute("data-theme", "light");
    await supportButton.click();
    await expect
      .poll(() =>
        options
          .locator(".support-dialog-panel")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .toBe("rgb(255, 255, 255)");
    await expect
      .poll(() => qr.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBe(216);
    await options.locator("#close-support-dialog").click();
  } finally {
    await closeProfile(profile);
  }
});

test("two isolated extension profiles create, join, synchronize, recover, and avoid echoes", async () => {
  const host = await launchProfile("host");
  const guest = await launchProfile("guest");
  try {
    await expect(host.popup.locator("#status-title")).toHaveText("Ready to sync");
    await expect(guest.popup.locator("#status-title")).toHaveText("Ready to sync");

    await host.popup.locator("#create-room").click();
    await expect(host.popup.locator("#room-panel")).toBeVisible();
    await expect(host.popup.locator("#participant-count")).toHaveText("1 of 8");
    await expect(host.popup.locator("#room-code-display")).toHaveText(/^[2-9A-HJ-NP-Z]{16}$/);
    const roomCode = (await host.popup.locator("#room-code-display").textContent())?.trim();
    expect(roomCode).toMatch(/^[2-9A-HJ-NP-Z]{16}$/);

    const hostBadge = host.fixture.locator("[data-vyzync='badge']");
    const hostBadgeToggle = hostBadge.locator(".badge-toggle");
    await expect(hostBadgeToggle).toHaveAttribute("aria-expanded", "false");
    await hostBadgeToggle.click();
    await expect(hostBadge.locator(".menu")).toBeVisible();
    await expect(hostBadge.locator(".friend-value")).toHaveText("Only you");
    await expect(hostBadge.locator(".quality-value")).toHaveText("Unavailable");
    await expect(hostBadge.locator("[data-action='copy']")).toBeEnabled();
    await expect(hostBadge.locator("[data-action='reconnect']")).toBeEnabled();
    await expect(hostBadge.locator("[data-action='leave']")).toBeEnabled();

    await hostBadge.locator("[data-action='copy']").click();
    await expect
      .poll(() => host.fixture.evaluate(() => navigator.clipboard.readText()))
      .toBe(roomCode);
    await expect(hostBadge.locator(".feedback")).toHaveText("Room code copied.");
    await hostBadgeToggle.click();

    await host.fixture.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 1;
    });
    await host.fixture.waitForTimeout(250);
    await guest.popup.locator("#room-code").fill(roomCode!);
    await guest.popup.locator("#join-form button[type='submit']").click();
    await expect(guest.popup.locator("#participant-count")).toHaveText("2 of 8");
    await expect(host.popup.locator("#participant-count")).toHaveText("2 of 8");
    await hostBadgeToggle.click();
    await expect(hostBadge.locator(".friend-value")).toHaveText("2 connected");
    await expect(hostBadge.locator(".quality-value")).toHaveText(/^(Good|Fair|Poor) · \d+ ms$/);

    const manualReconnectCountBefore = await host.worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
          }
        ).__watchSyncTelemetry?.outbound.filter((type) => type === "room.reconnect").length ?? 0,
    );
    await hostBadge.locator("[data-action='reconnect']").click();
    await expect
      .poll(() =>
        host.worker.evaluate(
          () =>
            (
              globalThis as unknown as {
                __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
              }
            ).__watchSyncTelemetry?.outbound.filter((type) => type === "room.reconnect").length ??
            0,
        ),
      )
      .toBeGreaterThan(manualReconnectCountBefore);
    await expect(host.popup.locator("#participant-count")).toHaveText("2 of 8");
    await expect(hostBadge.locator(".feedback")).toHaveText("Reconnected.");
    await hostBadgeToggle.click();
    await expect
      .poll(async () => Math.abs((await mediaState(guest.fixture)).currentTime - 1))
      .toBeLessThan(0.25);

    await host.fixture.locator("#main-video").evaluate(async (element) => {
      await (element as HTMLVideoElement).play();
    });
    await expect.poll(async () => (await mediaState(guest.fixture)).paused).toBe(false);

    await host.fixture.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).pause();
    });
    await expect.poll(async () => (await mediaState(guest.fixture)).paused).toBe(true);

    await host.fixture.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 2.5;
    });
    await expect
      .poll(async () => Math.abs((await mediaState(guest.fixture)).currentTime - 2.5))
      .toBeLessThan(0.25);

    await host.fixture.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).playbackRate = 1.25;
    });
    await expect
      .poll(async () => (await mediaState(guest.fixture)).playbackRate)
      .toBeCloseTo(1.25, 2);

    await host.fixture.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      video.currentTime = 3.5;
    });
    await expect
      .poll(async () => Math.abs((await mediaState(guest.fixture)).currentTime - 3.5))
      .toBeLessThan(0.25);
    await guest.fixture.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 0.2;
    });
    try {
      await expect
        .poll(async () => Math.abs((await mediaState(guest.fixture)).currentTime - 3.5), {
          timeout: 8_000,
        })
        .toBeLessThan(0.25);
    } catch (error) {
      console.log(
        JSON.stringify({
          hostState: await mediaState(host.fixture),
          guestState: await mediaState(guest.fixture),
          guestStatus: await guest.popup.locator("#status-title").textContent(),
          guestMessage: await guest.popup.locator("#status-message").textContent(),
          hostSocket: await host.worker.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
                }
              ).__watchSyncTelemetry,
          ),
          guestSocket: await guest.worker.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
                }
              ).__watchSyncTelemetry,
          ),
        }),
      );
      throw error;
    }
    const settledPausedDriftMs = Math.round(
      Math.abs(
        (await mediaState(host.fixture)).currentTime -
          (await mediaState(guest.fixture)).currentTime,
      ) * 1_000,
    );
    expect(settledPausedDriftMs).toBeLessThanOrEqual(250);

    await guest.fixture.reload();
    await expect
      .poll(() =>
        guest.fixture
          .locator("#main-video")
          .evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => Math.abs((await mediaState(guest.fixture)).currentTime - 3.5), {
        timeout: 8_000,
      })
      .toBeLessThan(0.35);

    const reconnectCountBefore = await guest.worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
          }
        ).__watchSyncTelemetry?.outbound.filter((type) => type === "room.reconnect").length ?? 0,
    );
    await guest.worker.evaluate(() => {
      (
        globalThis as unknown as {
          __watchSyncSockets?: WebSocket[];
        }
      ).__watchSyncSockets
        ?.at(-1)
        ?.close(4001, "deterministic E2E network transition");
    });
    await expect
      .poll(
        () =>
          guest.worker.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __watchSyncTelemetry?: { inbound: string[]; outbound: string[] };
                }
              ).__watchSyncTelemetry?.outbound.filter((type) => type === "room.reconnect").length ??
              0,
          ),
        { timeout: 8_000 },
      )
      .toBeGreaterThan(reconnectCountBefore);
    await expect(guest.popup.locator("#status-title")).not.toHaveText("Reconnecting", {
      timeout: 8_000,
    });

    await host.fixture.locator("#main-video").evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.currentTime = 0;
      video.playbackRate = 0.5;
      await video.play();
    });
    await expect.poll(async () => (await mediaState(guest.fixture)).paused).toBe(false);
    await host.fixture.locator("#simulate-buffer").click();
    await expect
      .poll(async () => (await mediaState(guest.fixture)).paused, { timeout: 4_000 })
      .toBe(true);
    await expect
      .poll(async () => (await mediaState(guest.fixture)).paused, { timeout: 8_000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          Math.abs(
            (await mediaState(host.fixture)).currentTime -
              (await mediaState(guest.fixture)).currentTime,
          ),
        { timeout: 8_000 },
      )
      .toBeLessThanOrEqual(0.25);
    const settledPlayingDriftMs = Math.round(
      Math.abs(
        (await mediaState(host.fixture)).currentTime -
          (await mediaState(guest.fixture)).currentTime,
      ) * 1_000,
    );
    expect(settledPlayingDriftMs).toBeLessThanOrEqual(250);
    console.log(
      `DRIFT_METRICS one-way=45-70ms paused=${settledPausedDriftMs}ms playing=${settledPlayingDriftMs}ms target=250ms`,
    );
    await test.info().attach("settled-drift-under-latency-and-jitter.json", {
      body: JSON.stringify(
        {
          deterministicOneWayLatencyMs: "45-70",
          pausedDriftMs: settledPausedDriftMs,
          playingDriftMs: settledPlayingDriftMs,
          targetMs: 250,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });

    const hostEvents = await host.fixture.evaluate(
      () => (globalThis as unknown as { fixtureEvents: Record<string, number> }).fixtureEvents,
    );
    const guestEvents = await guest.fixture.evaluate(
      () => (globalThis as unknown as { fixtureEvents: Record<string, number> }).fixtureEvents,
    );
    expect(Object.values(hostEvents).reduce((sum, value) => sum + value, 0)).toBeLessThan(40);
    expect(Object.values(guestEvents).reduce((sum, value) => sum + value, 0)).toBeLessThan(40);

    if ((await hostBadgeToggle.getAttribute("aria-expanded")) !== "true") {
      await hostBadgeToggle.click();
    }
    await hostBadge.locator("[data-action='leave']").click();
    await expect(guest.popup.locator("#status-title")).toHaveText("Sync service unavailable");
    await expect(hostBadge.locator(".title")).toHaveText("Ready");
  } finally {
    await Promise.all([closeProfile(host), closeProfile(guest)]);
  }
});

test("three extension profiles share one room, one timeline, and targeted host control", async () => {
  const host = await launchProfile("group-host");
  const firstGuest = await launchProfile("group-first-guest");
  const secondGuest = await launchProfile("group-second-guest");
  try {
    await host.popup.locator("#create-room").click();
    await expect(host.popup.locator("#room-code-display")).toHaveText(/^[2-9A-HJ-NP-Z]{16}$/);
    const roomCode = (await host.popup.locator("#room-code-display").textContent())!.trim();

    await firstGuest.popup.locator("#room-code").fill(roomCode);
    await firstGuest.popup.locator("#join-form button[type='submit']").click();
    await secondGuest.popup.locator("#room-code").fill(roomCode);
    await secondGuest.popup.locator("#join-form button[type='submit']").click();

    for (const profile of [host, firstGuest, secondGuest]) {
      await expect(profile.popup.locator("#participant-count")).toHaveText("3 of 8");
    }
    await expect(host.popup.locator("#host-transfer")).toBeVisible();
    await expect(host.popup.locator("#host-target option")).toHaveCount(2);

    const hostBadge = host.fixture.locator("[data-vyzync='badge']");
    await hostBadge.locator(".badge-toggle").click();
    await expect(hostBadge.locator(".friend-value")).toHaveText("3 connected");
    await expect(hostBadge.locator(".transfer-target option")).toHaveCount(2);

    await host.fixture.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      video.currentTime = 2.4;
    });
    for (const guest of [firstGuest, secondGuest]) {
      await expect
        .poll(async () => Math.abs((await mediaState(guest.fixture)).currentTime - 2.4))
        .toBeLessThan(0.25);
    }

    await host.popup.locator("#host-target").selectOption({ index: 1 });
    await host.popup.locator("#pass-host").click();
    await expect(host.popup.locator("#room-role")).toHaveText("You’re a guest");
    await expect(firstGuest.popup.locator("#room-role")).toHaveText("You’re a guest");
    await expect(secondGuest.popup.locator("#room-role")).toHaveText("You’re the host");

    await secondGuest.fixture.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      video.currentTime = 3.2;
    });
    for (const follower of [host, firstGuest]) {
      await expect
        .poll(async () => Math.abs((await mediaState(follower.fixture)).currentTime - 3.2))
        .toBeLessThan(0.25);
    }
  } finally {
    await Promise.all([closeProfile(host), closeProfile(firstGuest), closeProfile(secondGuest)]);
  }
});

test("one room follows both participants to matching videos in separate tabs", async () => {
  const host = await launchProfile("tab-handoff-host");
  const guest = await launchProfile("tab-handoff-guest");
  try {
    await host.popup.locator("#create-room").click();
    await expect(host.popup.locator("#room-code-display")).toHaveText(/^[2-9A-HJ-NP-Z]{16}$/);
    const roomCode = (await host.popup.locator("#room-code-display").textContent())!.trim();
    await guest.popup.locator("#room-code").fill(roomCode);
    await guest.popup.locator("#join-form button[type='submit']").click();
    await expect(host.popup.locator("#participant-count")).toHaveText("2 of 8");
    await expect(guest.popup.locator("#participant-count")).toHaveText("2 of 8");

    const hostNext = await openVideoTab(host, "spa.html");
    const guestNext = await openVideoTab(guest, "spa.html");

    await expect(host.popup.locator("#room-code-display")).toHaveText(roomCode);
    await expect(guest.popup.locator("#room-code-display")).toHaveText(roomCode);
    await expect(host.popup.locator("#participant-count")).toHaveText("2 of 8");
    await expect(guest.popup.locator("#participant-count")).toHaveText("2 of 8");

    await hostNext.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      video.currentTime = 2.25;
    });
    await expect
      .poll(async () => Math.abs((await mediaState(guestNext)).currentTime - 2.25), {
        timeout: 10_000,
      })
      .toBeLessThan(0.25);

    await hostNext.locator("#main-video").evaluate(async (element) => {
      await (element as HTMLVideoElement).play();
    });
    await expect.poll(async () => (await mediaState(guestNext)).paused).toBe(false);
    await hostNext.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).pause();
    });
    await expect.poll(async () => (await mediaState(guestNext)).paused).toBe(true);

    const settledPosition = (await mediaState(guestNext)).currentTime;
    await host.fixture.locator("#main-video").evaluate((element) => {
      const oldVideo = element as HTMLVideoElement;
      oldVideo.currentTime = 0.15;
      void oldVideo.play();
    });
    await guestNext.waitForTimeout(900);
    const afterInactiveTabAction = await mediaState(guestNext);
    expect(afterInactiveTabAction.paused).toBe(true);
    expect(Math.abs(afterInactiveTabAction.currentTime - settledPosition)).toBeLessThan(0.25);

    await Promise.all([host.fixture.close(), guest.fixture.close()]);
    await expect(host.popup.locator("#room-code-display")).toHaveText(roomCode);
    await expect(guest.popup.locator("#room-code-display")).toHaveText(roomCode);
    await expect(host.popup.locator("#participant-count")).toHaveText("2 of 8");
    await expect(guest.popup.locator("#participant-count")).toHaveText("2 of 8");

    await hostNext.locator("#main-video").evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 3.1;
    });
    await expect
      .poll(async () => Math.abs((await mediaState(guestNext)).currentTime - 3.1))
      .toBeLessThan(0.25);

    const hostConnectionTelemetry = await host.worker.evaluate(() => {
      const scope = globalThis as unknown as {
        __watchSyncSockets?: WebSocket[];
        __watchSyncTelemetry?: { outbound: string[] };
      };
      return {
        openSockets:
          scope.__watchSyncSockets?.filter((socket) => socket.readyState === WebSocket.OPEN)
            .length ?? 0,
        creates:
          scope.__watchSyncTelemetry?.outbound.filter((type) => type === "room.create").length ?? 0,
        reconnects:
          scope.__watchSyncTelemetry?.outbound.filter((type) => type === "room.reconnect").length ??
          0,
      };
    });
    const guestConnectionTelemetry = await guest.worker.evaluate(() => {
      const scope = globalThis as unknown as {
        __watchSyncSockets?: WebSocket[];
        __watchSyncTelemetry?: { outbound: string[] };
      };
      return {
        openSockets:
          scope.__watchSyncSockets?.filter((socket) => socket.readyState === WebSocket.OPEN)
            .length ?? 0,
        joins:
          scope.__watchSyncTelemetry?.outbound.filter((type) => type === "room.join").length ?? 0,
        reconnects:
          scope.__watchSyncTelemetry?.outbound.filter((type) => type === "room.reconnect").length ??
          0,
      };
    });
    expect(hostConnectionTelemetry.openSockets).toBe(1);
    expect(hostConnectionTelemetry.creates).toBe(1);
    expect(hostConnectionTelemetry.reconnects).toBeLessThanOrEqual(1);
    expect(guestConnectionTelemetry.openSockets).toBe(1);
    expect(guestConnectionTelemetry.joins).toBe(1);
    expect(guestConnectionTelemetry.reconnects).toBeLessThanOrEqual(1);

    await host.popup.locator("#end-room").click();
    await expect(guest.popup.locator("#status-title")).toHaveText("Sync service unavailable");
  } finally {
    await Promise.all([closeProfile(host), closeProfile(guest)]);
  }
});

test("the host can pass leadership and the former host follows the new host across videos", async () => {
  const originalHost = await launchProfile("transfer-original-host");
  const originalGuest = await launchProfile("transfer-original-guest");
  try {
    await originalHost.popup.locator("#create-room").click();
    await expect(originalHost.popup.locator("#room-code-display")).toHaveText(
      /^[2-9A-HJ-NP-Z]{16}$/,
    );
    const roomCode = (await originalHost.popup.locator("#room-code-display").textContent())!.trim();
    await originalGuest.popup.locator("#room-code").fill(roomCode);
    await originalGuest.popup.locator("#join-form button[type='submit']").click();
    await expect(originalHost.popup.locator("#participant-count")).toHaveText("2 of 8");
    await expect(originalGuest.popup.locator("#participant-count")).toHaveText("2 of 8");

    await expect(originalHost.popup.locator("#pass-host")).toBeVisible();
    await expect(originalGuest.popup.locator("#pass-host")).toBeHidden();
    await originalHost.popup.locator("#pass-host").click();

    await expect(originalHost.popup.locator("#room-role")).toHaveText("You’re a guest");
    await expect(originalGuest.popup.locator("#room-role")).toHaveText("You’re the host");
    await expect(originalHost.popup.locator("#pass-host")).toBeHidden();
    await expect(originalHost.popup.locator("#end-room")).toBeHidden();
    await expect(originalGuest.popup.locator("#pass-host")).toBeVisible();
    await expect(originalGuest.popup.locator("#end-room")).toBeVisible();
    await expect(originalHost.popup.locator("#room-code-wrap")).toBeHidden();
    await expect(originalGuest.popup.locator("#room-code-display")).toHaveText(roomCode);

    const formerHostBadge = originalHost.fixture.locator("[data-vyzync='badge']");
    const newHostBadge = originalGuest.fixture.locator("[data-vyzync='badge']");
    await formerHostBadge.locator(".badge-toggle").click();
    await newHostBadge.locator(".badge-toggle").click();
    await expect(formerHostBadge.locator("[data-action='transfer']")).toBeHidden();
    await expect(newHostBadge.locator("[data-action='transfer']")).toBeVisible();

    const newHostVideo = await openVideoTab(originalGuest, "spa.html");
    await expect(originalHost.popup.locator("#status-title")).toHaveText(
      "Different videos detected",
    );
    await expect(originalHost.popup.locator("#status-message")).toHaveText(
      "The videos don’t match. Open the host’s video to continue.",
    );
    await expect(originalGuest.popup.locator("#status-message")).toHaveText(
      "1 person is on a different video.",
    );

    const formerHostVideo = await openVideoTab(originalHost, "spa.html");
    await expect(originalHost.popup.locator("#room-code-display")).toHaveText(roomCode);
    await expect(originalGuest.popup.locator("#room-code-display")).toHaveText(roomCode);
    await expect(originalHost.popup.locator("#status-title")).not.toHaveText(
      "Different videos detected",
    );

    await newHostVideo.locator("#main-video").evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      video.currentTime = 2.8;
    });
    await expect
      .poll(async () => Math.abs((await mediaState(formerHostVideo)).currentTime - 2.8), {
        timeout: 10_000,
      })
      .toBeLessThan(0.25);

    const transferTelemetry = await originalHost.worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            __watchSyncTelemetry?: { outbound: string[] };
          }
        ).__watchSyncTelemetry?.outbound.filter((type) => type === "room.transfer-host").length ??
        0,
    );
    expect(transferTelemetry).toBe(1);
  } finally {
    await Promise.all([closeProfile(originalHost), closeProfile(originalGuest)]);
  }
});

test("multiple-video ranking and SPA replacement remain controllable", async () => {
  const profile = await launchProfile("edge-cases", "multi.html");
  try {
    await expect(profile.popup.locator("#status-title")).toHaveText("Multiple videos detected");
    await expect(profile.popup.locator("#status-message")).toHaveText(
      "The main video is selected. Choose another if needed.",
    );
    await profile.fixture.bringToFront();
    await profile.fixture.locator("[data-vyzync='badge'] .badge-toggle").click();
    await expect(profile.fixture.locator("[data-vyzync='badge'] .expanded-detail")).toHaveText(
      "Multiple videos detected. The main video is selected. Choose another if needed.",
    );
    await expect(profile.popup.locator("#picker-toggle")).toBeVisible();
    await profile.popup.locator("#picker-toggle").click();
    await expect(profile.popup.locator("#video-picker button")).toHaveCount(2);
    await expect(profile.popup.locator("#video-picker button[aria-pressed='true']")).toContainText(
      "Main full-size flower video",
    );
    await profile.popup.locator("#create-room").click();
    await expect(profile.popup.locator("#room-panel")).toBeVisible();
    await expect(profile.popup.locator("#compatibility-notice")).toBeVisible();
    await expect(profile.popup.locator("#compatibility-title")).toHaveText(
      "Multiple videos detected",
    );
    await expect(profile.popup.locator("#compatibility-message")).toHaveText(
      "The main video is selected. Choose another if needed.",
    );

    await profile.fixture.goto("http://127.0.0.1:4173/spa.html");
    await expect(profile.fixture.locator("#main-video")).toHaveJSProperty("readyState", 4);
    await profile.fixture.locator("#replace-video").click();
    await expect(profile.fixture.locator("#main-video")).toHaveCount(1);
    await expect(profile.popup.locator("#video-title")).toHaveText(
      "SPA Video Replacement Fixture",
      { timeout: 8_000 },
    );
  } finally {
    await closeProfile(profile);
  }
});

test("unsupported players show a plain compatibility notice", async () => {
  const profile = await launchProfile("unsupported-player", "unsupported.html");
  try {
    await expect(profile.popup.locator("#status-title")).toHaveText("This player isn’t supported");
    await expect(profile.popup.locator("#status-message")).toHaveText("Try another video or site.");
    await expect(profile.popup.locator("#error-message")).toBeHidden();
    await profile.fixture.bringToFront();
    await expect(profile.fixture.locator("[data-vyzync='badge'] .title")).toHaveText(
      "Unsupported player",
    );
    await profile.fixture.locator("[data-vyzync='badge'] .badge-toggle").click();
    await expect(profile.fixture.locator("[data-vyzync='badge'] .expanded-title")).toHaveText(
      "This player isn’t supported",
    );
    await expect(profile.fixture.locator("[data-vyzync='badge'] .expanded-detail")).toHaveText(
      "Try another video or site.",
    );
  } finally {
    await closeProfile(profile);
  }
});

test("mismatched videos are visible and block remote control", async () => {
  const host = await launchProfile("mismatch-host", "single.html");
  const guest = await launchProfile("mismatch-guest", "spa.html");
  try {
    await host.popup.locator("#create-room").click();
    await expect(host.popup.locator("#room-code-display")).toHaveText(/^[2-9A-HJ-NP-Z]{16}$/);
    const roomCode = (await host.popup.locator("#room-code-display").textContent())!.trim();
    await guest.popup.locator("#room-code").fill(roomCode);
    await guest.popup.locator("#join-form button[type='submit']").click();
    await expect(host.popup.locator("#status-title")).toHaveText("Different videos detected");
    await expect(guest.popup.locator("#status-title")).toHaveText("Different videos detected");

    await host.fixture.locator("#main-video").evaluate(async (element) => {
      await (element as HTMLVideoElement).play();
    });
    await guest.fixture.waitForTimeout(750);
    await expect.poll(async () => (await mediaState(guest.fixture)).paused).toBe(true);
  } finally {
    await Promise.all([closeProfile(host), closeProfile(guest)]);
  }
});
