import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "../../apps/extension");
const source = join(extensionRoot, ".output/chrome-mv3");
const outputRoot = join(extensionRoot, ".output") + sep;
const target = join(extensionRoot, ".output/chrome-mv3-e2e");

if (!target.startsWith(outputRoot) || target === outputRoot.slice(0, -1)) {
  throw new Error("Refusing to prepare an E2E extension outside the extension output directory");
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const manifestPath = join(target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.name = `${manifest.name} (E2E)`;
manifest.host_permissions = ["http://127.0.0.1/*"];
manifest.optional_host_permissions = [];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
