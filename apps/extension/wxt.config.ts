import { defineConfig } from "wxt";

const OPTIONAL_HOSTS = ["http://*/*", "https://*/*"];

interface GeneratedManifest {
  host_permissions?: string[];
  optional_host_permissions?: string[];
}

export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "Two Person Video Sync",
    short_name: "Video Sync",
    description: "Keep playback state synchronized for exactly two viewers. Media is never shared.",
    version: "0.2.2",
    ...(browser === "chrome" ? { minimum_chrome_version: "116" } : {}),
    permissions: ["activeTab", "clipboardWrite", "scripting", "storage"],
    optional_host_permissions: OPTIONAL_HOSTS,
    action: {
      default_title: "Two Person Video Sync",
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
              id: "two-person-video-sync@local.invalid",
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
      manifest.optional_host_permissions = Array.from(
        new Set([...(manifest.optional_host_permissions ?? []), ...OPTIONAL_HOSTS]),
      );
    },
  },
});
