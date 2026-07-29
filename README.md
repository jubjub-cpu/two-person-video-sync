# Two Person Video Sync

A Chrome and Firefox extension that keeps play, pause, seeking, and playback speed synchronized for two people watching the same HTML5 video.

Each person streams the video from their own account. The extension does not share, download, or transmit video or audio.

## Install

Download the files from the [latest release](https://github.com/jubjub-cpu/two-person-video-sync/releases/latest).

### Chrome

1. Download `video-sync-chrome-0.1.0.zip`.
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Select **Load unpacked** and choose the extracted folder.

### Firefox

1. Download `video-sync-firefox-unsigned-0.1.0.zip`.
2. Extract the ZIP.
3. Open `about:debugging#/runtime/this-firefox`.
4. Select **Load Temporary Add-on**.
5. Choose `manifest.json` from the extracted folder.

Firefox removes temporary add-ons when the browser closes. Permanent one-click browser installation requires publication through the Chrome Web Store or Firefox Add-ons.

## Start the synchronization service

Both people must use the same synchronization service.

For local use, install [Node.js 24 LTS](https://nodejs.org/) and run these commands from the repository folder:

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @watch-sync/server build
pnpm --filter @watch-sync/server start
```

Use `ws://127.0.0.1:8787/ws` in the extension settings.

For two people on different networks, deploy the included server and configure the same secure `wss://` address in both extensions. See [deployment instructions](docs/DEPLOYMENT.md).

## Use

1. Both people open the same video.
2. Open the extension and select **Enable on this site**.
3. One person selects **Create private room** and shares the room code.
4. The other person enters the code and selects **Join**.
5. Use the video controls normally.
6. Select **Leave room** when finished.

The host controls playback by default. Shared control can be enabled before creating the room.

## Build from source

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

The extension builds are created in `apps/extension/.output`.

## Privacy and security

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
