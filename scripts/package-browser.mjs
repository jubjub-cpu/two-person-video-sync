import { spawn } from "node:child_process";
import { resolve } from "node:path";

const browser = process.argv[2];
if (!new Set(["firefox", "opera"]).has(browser)) {
  throw new Error(`Unsupported browser source-package target: ${browser ?? "missing"}`);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const wxtCli = resolve(repositoryRoot, "apps/extension/node_modules/wxt/bin/wxt.mjs");

const exitCode = await new Promise((resolveExitCode, reject) => {
  const child = spawn(
    process.execPath,
    [wxtCli, "zip", "apps/extension", "--browser", browser, "--mv3"],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`${browser} packaging stopped by signal ${signal}`));
    else resolveExitCode(code ?? 1);
  });
});

if (exitCode !== 0) process.exit(exitCode);
