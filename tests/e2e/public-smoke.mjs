import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { chromium } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const extensionOutputRoot = resolve(repositoryRoot, "apps/extension/.output");
const source = join(extensionOutputRoot, "chrome-mv3");
const extensionPath = join(extensionOutputRoot, "chrome-mv3-public-smoke");
const profilesRoot = resolve(import.meta.dirname, ".profiles");
const targets = [
  {
    provider: "YouTube",
    url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
  },
  {
    provider: "Vimeo",
    url: "https://vimeo.com/171817798",
  },
];

if (!extensionPath.startsWith(extensionOutputRoot + sep)) {
  throw new Error("Refusing to prepare a public smoke extension outside its output directory");
}

await rm(extensionPath, { recursive: true, force: true });
await cp(source, extensionPath, { recursive: true });
const manifestPath = join(extensionPath, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.name = `${manifest.name} (Public smoke)`;
manifest.host_permissions = ["https://www.youtube.com/*", "https://vimeo.com/*"];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

await mkdir(profilesRoot, { recursive: true });
const profilePath = await mkdtemp(join(profilesRoot, "public-smoke-"));
if (!profilePath.startsWith(profilesRoot + sep)) {
  throw new Error("Refusing to use a public smoke profile outside the profiles directory");
}
let context;

try {
  context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).hostname;

  for (const target of targets) {
    const result = {
      provider: target.provider,
      requestedUrl: target.url,
      finalUrl: "",
      pageTitle: "",
      statusTitle: "",
      statusMessage: "",
      detected: false,
      navigationError: "",
    };
    const page = await context.newPage();
    try {
      await page.goto(target.url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    } catch (error) {
      result.navigationError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(8_000);
    result.finalUrl = page.url();
    result.pageTitle = await page.title().catch(() => "");

    const tabId = await worker.evaluate(async (expectedUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === expectedUrl)?.id;
    }, result.finalUrl);

    if (tabId !== undefined) {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        result.statusTitle =
          (
            await popup
              .locator("#status-title")
              .textContent()
              .catch(() => "")
          )?.trim() ?? "";
        result.statusMessage =
          (
            await popup
              .locator("#status-message")
              .textContent()
              .catch(() => "")
          )?.trim() ?? "";
        if (result.statusTitle !== "" && result.statusTitle !== "Checking this page…") break;
        await popup.waitForTimeout(500);
      }
      result.detected = result.statusTitle === "Ready to sync";
      await popup.close();
    } else {
      result.statusMessage = "The smoke harness could not resolve the public page's browser tab.";
    }

    console.log(`PUBLIC_SMOKE_RESULT ${JSON.stringify(result)}`);
    await page.close();
  }
} finally {
  await context?.close();
  await rm(profilePath, { recursive: true, force: true });
}
