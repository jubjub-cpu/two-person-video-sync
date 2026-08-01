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
      closeIconUrl: browser.runtime.getURL("/icons/ui/x.svg"),
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
