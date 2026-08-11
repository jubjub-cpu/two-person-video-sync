# Deploy the Synchronization Service

The released extension uses its bundled secure relay. These instructions are for maintainers who want to operate a separate instance and build the extension for it.

The public relay used by Vyzync is
`wss://two-person-video-sync-jubjub-cpu.onrender.com/ws`. Its health endpoint is
`https://two-person-video-sync-jubjub-cpu.onrender.com/health`.

## Deploy with Render

1. Open [Deploy to Render](https://render.com/deploy?repo=https://github.com/jubjub-cpu/two-person-video-sync).
2. Sign in, review the free web service, and select **Deploy Blueprint**.
3. Wait for `/health` to report `status: ok`.
4. Use the service address with `/ws`, for example `wss://YOUR-SERVICE.onrender.com/ws`.

The included `render.yaml` configures one Docker instance, TLS proxy awareness, the health check, extension-origin access, and an eight-participant room limit. Set `MAX_PARTICIPANTS_PER_ROOM` between 2 and 32 to choose a different capacity. The server keeps rooms in memory, so restarting the service ends active rooms and more than one instance is not supported.

## Build for a separate relay

Set the secure relay address before creating production browser packages:

```powershell
$env:WXT_SYNC_SERVER_URL = "wss://YOUR-SERVICE.example/ws"
pnpm --filter @vyzync/extension package:all
```

The address is built into the extension. End users do not enter it in Settings.

## Run locally

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @vyzync/server build
pnpm --filter @vyzync/server start
```

Development and test builds use `ws://127.0.0.1:8787/ws` by default.

## Run with Docker

```powershell
docker build --file apps/server/Dockerfile --tag vyzync-server:0.4.1 .
docker run --rm `
  --name vyzync-server `
  --publish 8787:8787 `
  --env HOST=0.0.0.0 `
  --env PORT=8787 `
  vyzync-server:0.4.1
```

Public deployments must terminate TLS, set `TRUST_PROXY=true`, use `wss://`, keep one service instance, and keep room credentials out of URLs and logs.
