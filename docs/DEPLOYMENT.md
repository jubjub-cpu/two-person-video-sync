# Deploy the Synchronization Service

Remote users must connect their extensions to the same secure WebSocket service.

## Requirements

- Node.js 24 LTS
- A host that supports Docker and WebSockets
- One service instance
- HTTPS/TLS enabled by the host

## Run locally

From the repository folder:

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @watch-sync/server build
pnpm --filter @watch-sync/server start
```

Check the service:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Set the extension endpoint to:

```text
ws://127.0.0.1:8787/ws
```

## Run with Docker

Build the image from the repository folder:

```powershell
docker build --file apps/server/Dockerfile --tag two-person-video-sync-server:0.1.0 .
```

Run one container:

```powershell
docker run --rm `
  --name two-person-video-sync-server `
  --publish 8787:8787 `
  --env HOST=0.0.0.0 `
  --env PORT=8787 `
  two-person-video-sync-server:0.1.0
```

## Deploy to a hosting provider

1. Create one Docker web service from this repository.
2. Use `apps/server/Dockerfile`.
3. Set the health-check path to `/health`.
4. Set `NODE_ENV=production`.
5. Set `HOST=0.0.0.0`.
6. Let the provider supply `PORT`.
7. Keep the service at one instance.
8. Deploy the service.
9. Confirm that `https://YOUR_HOST/health` responds.
10. Set both extensions to `wss://YOUR_HOST/ws`.

The current server stores rooms in memory. Restarting the service ends active rooms, and running more than one instance will prevent reliable room reconnection.

## Extension settings

On both computers:

1. Open the extension.
2. Open **Settings**.
3. Enter the same `wss://YOUR_HOST/ws` address.
4. Save the setting.
5. Create or join a room.
