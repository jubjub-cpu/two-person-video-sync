# Privacy Notice

Last updated: August 3, 2026

Vyzync coordinates playback state between exactly two people. It does not
capture, download, decrypt, proxy, rebroadcast, or share audio or video. Each participant
loads the video independently through their own legitimate website account, subscription,
device, region, and network connection.

## Data transmitted to the synchronization service

While a room is active, the extension sends only the minimum metadata needed to compare and
coordinate the two players:

- protocol, room, participant, session, command, and sequence identifiers;
- the page origin and a normalized or fingerprinted content identity;
- a title fingerprint, not the raw page title;
- duration, seekability, live/ad capability state, and a safe provider identifier;
- current time, paused/playing/ended state, playback rate, readiness, and buffering state;
- ping/pong timestamps used to estimate latency and clock offset; and
- short-lived reconnection credentials.

Room codes and reconnection credentials are authentication secrets. They are transmitted to
the service over secure WebSocket, are redacted from application logs, expire, and are
removed from local storage when the session ends.

The implementation does **not** send page contents, DOM contents, media bytes, cookies,
streaming-service tokens, passwords, account information, captions, audio language, volume,
mute state, video quality, fullscreen state, browsing history, or unrelated URLs.

Firefox classifies the required active-room transmission as `browsingActivity`,
`websiteContent`, and `websiteActivity` because it includes the active video origin,
privacy-minimized content identity, and playback actions. These are declared in the Firefox
manifest. They are used only to provide the user-requested room synchronization feature, not
for analytics, advertising, profiling, or sale.

## Data stored locally

The extension uses browser-local extension storage for:

- the default control mode and badge preference;
- site-origin grants selected by the user;
- an expiring active-room reconnection session; and
- up to 200 recent privacy-safe diagnostic entries.

Diagnostics record state transitions, latency, drift, adapter choice, and error categories.
Their sanitizer drops fields whose names indicate a token, secret, code, URL, or title.
Diagnostics remain on the device unless the user exports or clears them.

The extension does not use browser-sync storage, analytics, advertising identifiers,
fingerprinting, or third-party tracking SDKs.

## Service retention

The included single-instance service stores active room state in memory only. Rooms have a
maximum lifetime and idle timeout, inactive rooms are removed automatically, and a process
restart removes all room state. The service writes structured operational logs with secrets
redacted. Operators who deploy the service are responsible for configuring access,
transport security, infrastructure logs, retention, and the public privacy notice.

## Permissions

Required browser permissions are limited to:

- `storage` for settings, active-session recovery, and local diagnostics;
- `clipboardWrite` to copy a newly created room code at the user's request;
- `scripting` to register and inject the packaged content controller; and
- `activeTab` for the user-initiated current-tab flow.

Website access is optional. The extension asks for the exact current HTTP(S) origin when the
user selects “Enable on this site.” The options page also offers an explicit all-websites
grant. Access can be revoked through the browser at any time; revocation unregisters future
injection and tells an already-running controller to clean up.

The extension never reads clipboard contents. It does not request cookies, history,
downloads, tab capture, microphone, camera, geolocation, request interception, or
browsing-history permissions.

## User choices

Users can leave or end a room, revoke site access, hide the page badge, export sanitized
diagnostics, clear diagnostics, or uninstall the extension. Uninstalling removes
browser-managed local extension data.

Release builds include the service address. Development builds use the local service by
default. Operators of separate public deployments must use HTTPS/WSS.
