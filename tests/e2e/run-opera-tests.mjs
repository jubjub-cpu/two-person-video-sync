import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const candidates = [
  process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, "Programs/Opera/opera.exe")
    : undefined,
  process.env.ProgramFiles ? resolve(process.env.ProgramFiles, "Opera/opera.exe") : undefined,
  process.env["ProgramFiles(x86)"]
    ? resolve(process.env["ProgramFiles(x86)"], "Opera/opera.exe")
    : undefined,
  "/Applications/Opera.app/Contents/MacOS/Opera",
  "/usr/bin/opera",
  "/usr/bin/opera-stable",
  "/snap/bin/opera",
].filter(Boolean);

async function findOperaExecutable() {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through known installation locations.
    }
  }
  return undefined;
}

const operaExecutable = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (await findOperaExecutable());
if (!operaExecutable) {
  throw new Error(
    "Opera is not installed in a known location. Set PLAYWRIGHT_CHROMIUM_PATH to opera.exe.",
  );
}

const playwrightCli = resolve(import.meta.dirname, "node_modules/@playwright/test/cli.js");
const playwrightArguments = process.argv.slice(2);
if (playwrightArguments[0] === "--") playwrightArguments.shift();
const exitCode = await new Promise((resolveExitCode, reject) => {
  const child = spawn(process.execPath, [playwrightCli, "test", ...playwrightArguments], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      PLAYWRIGHT_CHROMIUM_PATH: operaExecutable,
      VYZYNC_E2E_BROWSER: "opera",
    },
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Opera E2E tests stopped by signal ${signal}`));
    else resolveExitCode(code ?? 1);
  });
});

if (exitCode !== 0) process.exit(exitCode);
