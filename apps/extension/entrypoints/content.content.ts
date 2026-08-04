import { browser } from "wxt/browser";

import { getSettings, SETTINGS_KEY } from "../lib/settings";
import { MediaSessionController } from "../lib/sync/media-controller";

const INSTANCE_KEY = "__twoPersonVideoSyncController";

declare global {
  interface Window {
    [INSTANCE_KEY]?: MediaSessionController;
  }
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  registration: "runtime",
  runAt: "document_idle",
  noScriptStartedPostMessage: true,
  async main() {
    if (window[INSTANCE_KEY]) return;
    const settings = await getSettings();
    const controller = new MediaSessionController({
      showBadge: settings.showBadge,
      themeMode: settings.themeMode,
      badgeIcons: {
        chevron: browser.runtime.getURL("/icons/ui/chevron-down.svg"),
        close: browser.runtime.getURL("/icons/ui/x.svg"),
        copy: browser.runtime.getURL("/icons/ui/copy.svg"),
        leave: browser.runtime.getURL("/icons/ui/logout.svg"),
        reconnect: browser.runtime.getURL("/icons/ui/refresh.svg"),
        userConnected: browser.runtime.getURL("/icons/ui/user-check.svg"),
        userDisconnected: browser.runtime.getURL("/icons/ui/user-x.svg"),
        wifi: browser.runtime.getURL("/icons/ui/wifi.svg"),
      },
      onDestroy: () => {
        browser.storage.onChanged.removeListener(handleSettingsChange);
        delete window[INSTANCE_KEY];
      },
    });
    const handleSettingsChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "local" || !(SETTINGS_KEY in changes)) return;
      void getSettings().then((next) => {
        controller.setBadgeAppearance(next.showBadge, next.themeMode);
      });
    };
    browser.storage.onChanged.addListener(handleSettingsChange);
    window[INSTANCE_KEY] = controller;
    controller.start();
  },
});
