import { resolve } from "node:path";
import { defineConfig } from "wxt";

const OPTIONAL_HOSTS = ["http://*/*", "https://*/*"];

interface GeneratedManifest {
  content_scripts?: unknown[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
}

export default defineConfig({
  manifestVersion: 3,
  targetBrowsers: ["chrome", "firefox", "opera"],
  zip: {
    sourcesRoot: resolve(import.meta.dirname, "../.."),
    dotSources: true,
    includeSources: [
      ".npmrc",
      ".prettierrc.json",
      "LICENSE",
      "PRIVACY.md",
      "README.md",
      "SECURITY.md",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "apps/extension/entrypoints/**",
      "apps/extension/import-meta.d.ts",
      "apps/extension/lib/**",
      "apps/extension/package.json",
      "apps/extension/public/**",
      "apps/extension/tsconfig.json",
      "apps/extension/vitest.config.ts",
      "apps/extension/wxt.config.ts",
      "packages/protocol/package.json",
      "packages/protocol/src/**",
      "packages/protocol/tsconfig.build.json",
      "packages/protocol/tsconfig.json",
      "packages/sync-core/package.json",
      "packages/sync-core/src/**",
      "packages/sync-core/tsconfig.build.json",
      "packages/sync-core/tsconfig.json",
      "scripts/package-browser.mjs",
      "scripts/verify-opera-build.mjs",
    ],
    sourcesTemplate: "{{name}}-{{version}}-{{browser}}-sources.zip",
  },
  manifest: ({ browser }) => ({
    name: "Vyzync",
    short_name: "Vyzync",
    description:
      "Watch video together with up to eight people. Keep play, pause, seeking, and speed in sync.",
    version: "0.4.1",
    ...(browser === "chrome" ? { minimum_chrome_version: "116" } : {}),
    permissions: ["activeTab", "clipboardWrite", "scripting", "storage"],
    optional_host_permissions: OPTIONAL_HOSTS,
    action: {
      default_title: "Vyzync",
    },
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      96: "icons/icon-96.png",
      128: "icons/icon-128.png",
    },
    browser_specific_settings:
      browser === "firefox"
        ? {
            gecko: {
              id: "vyzync@jubjub-cpu.github.io",
              strict_min_version: "140.0",
              data_collection_permissions: {
                required: ["browsingActivity", "websiteContent", "websiteActivity"],
              },
            },
            gecko_android: {
              strict_min_version: "142.0",
            },
          }
        : undefined,
  }),
  hooks: {
    "build:manifestGenerated": (_wxt, rawManifest: unknown) => {
      // WXT's runtime content-script mode adds matches to required host permissions. This
      // project deliberately requests each origin at runtime, so keep those hosts optional.
      const manifest = rawManifest as GeneratedManifest;
      manifest.host_permissions = (manifest.host_permissions ?? []).filter(
        (permission: string) => !OPTIONAL_HOSTS.includes(permission),
      );
      if (manifest.host_permissions.length === 0) {
        delete manifest.host_permissions;
      }
      if (manifest.content_scripts?.length === 0) {
        delete manifest.content_scripts;
      }
      manifest.optional_host_permissions = Array.from(
        new Set([...(manifest.optional_host_permissions ?? []), ...OPTIONAL_HOSTS]),
      );
    },
  },
});
