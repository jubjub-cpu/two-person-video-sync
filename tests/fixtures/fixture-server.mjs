import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const environment = typeof process === "undefined" ? {} : process.env;
const port = Number(environment.FIXTURE_PORT ?? 4173);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
};

export const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  const requested = pathname === "/" ? "/single.html" : pathname;
  const relative = normalize(requested).replace(/^([/\\])+/, "");
  const path = join(root, relative);
  if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const size = statSync(path).size;
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "cross-origin-resource-policy": "same-origin",
  };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (start >= size || end < start) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
    });
    createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": size });
  createReadStream(path).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fixture-ready:${port}`);
});
