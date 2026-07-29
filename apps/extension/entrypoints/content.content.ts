import { getSettings } from "../lib/settings";
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
    const controller = new MediaSessionController(settings.showBadge, () => {
      delete window[INSTANCE_KEY];
    });
    window[INSTANCE_KEY] = controller;
    controller.start();
  },
});
