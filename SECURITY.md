# Security

## Supported release

The current release line is `0.4.x`. Release builds use the hosted synchronization relay.
Public browser builds are distributed only through the official store links in `README.md`.
GitHub ZIP files are source or reviewer packages, not signed browser-store installers.

## Reporting a vulnerability

Do not open a public issue containing an active room code, reconnection credential, private
URL, exploit details, or personal information. Until a private security-reporting address is
listed, report privately to the person or organization that distributed your build.

Include the affected version, browser and server versions, impact, minimal reproduction, and
whether any credential may have been exposed. Never include a real streaming-service
password, cookie, or token.

## Security model

- Room codes use 80 bits of platform cryptographic randomness and expire.
- Internal entity IDs and short-lived reconnect tokens use platform cryptographic randomness.
- The server enforces two active participants, authenticated sessions, role-based command
  authorization, monotonic ordering, duplicate rejection, expiration, payload limits, origin
  policy, and per-IP/per-connection rate limits.
- Client and server messages are runtime validated against the same strict, versioned Zod
  schemas. The extension also enforces the shared 16 KiB receive limit.
- Public endpoints must use `wss://`; plaintext WebSocket is accepted only for loopback local
  development.
- The included store is in memory and replaceable. A single instance is required unless room
  state and broadcast coordination move to shared infrastructure.
- Secrets are kept out of URLs and are redacted from logs and diagnostics.
- The extension contains no remotely hosted code, `eval`, analytics, ad SDK, request
  interception, or media-capture capability.

## Threat boundaries and limitations

A room code is a bearer secret: anyone who obtains it before it expires may attempt to join.
Share it through a trusted channel. A compromised browser page can observe and interfere with
its own video element; extension isolated worlds reduce but cannot eliminate a hostile site's
ability to replace or manipulate the player. A relay operator can observe the privacy-minimized
synchronization metadata described in `PRIVACY.md`.

The extension does not bypass DRM, subscriptions, regional controls, advertisements, or
autoplay policy. It deliberately suspends synchronization when identity, duration, live,
advertisement, or capability checks indicate that corrective seeking could be unsafe.

## Deployment hardening

Before exposing the service publicly:

1. Terminate TLS and use only `wss://`.
2. Set exact released extension origins in `ALLOWED_ORIGINS`.
3. Run one application instance while using the in-memory room store.
4. Place a reputable reverse proxy/load balancer in front of the service and retain the
   conservative body, WebSocket, and rate limits.
5. Run as a non-root container user with a read-only filesystem where the platform permits.
6. Patch the Node 24 LTS base image and production dependencies regularly.
7. Keep infrastructure access logs short-lived and never add query-string room credentials.
8. Re-run formatting, lint, type checking, all tests, `pnpm audit --prod`, Firefox lint, Opera
   build verification, and the repository secret scan before every release.

## Dependency and source integrity

Dependencies are locked by `pnpm-lock.yaml`. Release artifacts must be reproduced from a
clean checkout and compared with the generated manifest, permission list, and documented
hashes. Store submissions should include the reproducible source archives required by Mozilla
and Opera.
