# Two Person Video Sync

A Chrome and Firefox extension that keeps play, pause, seeking, and playback speed synchronized for two people watching the same HTML5 video.

Each person streams the video from their own account. The extension does not share, download, or transmit video or audio.

## Install

Download the files from the [latest release](https://github.com/jubjub-cpu/two-person-video-sync/releases/latest).

### Chrome

1. Download `video-sync-chrome-0.2.1.zip`.
2. Extract the ZIP.
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder.

### Firefox

1. Download `video-sync-firefox-unsigned-0.2.1.zip`.
2. Extract the ZIP.
3. Open `about:debugging#/runtime/this-firefox`.
4. Select **Load Temporary Add-on** and choose `manifest.json` from the extracted folder.

Firefox removes temporary add-ons when the browser closes. Permanent browser installation requires publication through the Chrome Web Store or Firefox Add-ons.

## Use

1. Both people open the same video and select **Enable on this site** once.
2. The host selects **Create private room**. The room code is copied automatically.
3. The other person pastes the code into **Join a room** and presses Enter.

The synchronization service is already included in the extension. No server address or connection setup is required. The first room after the free service has been idle can take up to a minute to start.

The host controls playback by default. **Either person** mode can be selected before creating the room.

## Build from source

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

The extension builds are created in `apps/extension/.output`. To operate a separate relay, see the [deployment instructions](docs/DEPLOYMENT.md).

## Privacy and security

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
