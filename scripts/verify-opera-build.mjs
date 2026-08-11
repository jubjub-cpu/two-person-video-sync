import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import JSZip from "jszip";

const outputRoot = resolve(import.meta.dirname, "../apps/extension/.output");
const outputDirectory = resolve(outputRoot, "opera-mv3");
const manifestPath = resolve(outputDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert.equal(manifest.manifest_version, 3, "Opera must use Manifest V3");
assert.equal(manifest.name, "Vyzync", "Opera package has the wrong extension name");
assert.match(manifest.version, /^\d+(?:\.\d+){1,3}$/, "Opera package has an invalid version");
assert.equal(
  manifest.background?.service_worker,
  "background.js",
  "Opera package is missing its background service worker",
);
assert.equal(
  manifest.action?.default_popup,
  "popup.html",
  "Opera package is missing its toolbar popup",
);
assert.equal(
  manifest.options_ui?.page,
  "options.html",
  "Opera package is missing its settings page",
);

assert.deepEqual(
  [...(manifest.permissions ?? [])].sort(),
  ["activeTab", "clipboardWrite", "scripting", "storage"].sort(),
  "Opera package permissions changed unexpectedly",
);
assert.deepEqual(
  [...(manifest.optional_host_permissions ?? [])].sort(),
  ["http://*/*", "https://*/*"].sort(),
  "Opera website access must remain optional",
);
assert.equal(manifest.host_permissions, undefined, "Opera package has required website access");
assert.equal(
  manifest.content_scripts,
  undefined,
  "Opera package must omit the content_scripts field when scripts use runtime registration",
);
assert.equal(
  manifest.browser_specific_settings,
  undefined,
  "Opera package contains Firefox-only manifest settings",
);
assert.equal(
  manifest.minimum_chrome_version,
  undefined,
  "Opera package contains a Chrome-only minimum version",
);

const packagedFiles = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons ?? {}),
]);
await Promise.all([...packagedFiles].map((file) => access(resolve(outputDirectory, file))));

if (process.argv.includes("--package")) {
  const extensionArtifact = `vyzyncextension-${manifest.version}-opera.zip`;
  const sourcesArtifact = `vyzyncextension-${manifest.version}-opera-sources.zip`;
  const expectedArtifacts = [extensionArtifact, sourcesArtifact];
  for (const artifact of expectedArtifacts) {
    const artifactStats = await stat(resolve(outputRoot, artifact));
    assert.ok(artifactStats.size > 1_000, `${artifact} is empty or incomplete`);
  }

  const sourcesArchive = await JSZip.loadAsync(
    await readFile(resolve(outputRoot, sourcesArtifact)),
  );
  const sources = new Set(Object.keys(sourcesArchive.files));
  const requiredSources = [
    ".npmrc",
    ".prettierrc.json",
    "LICENSE",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "apps/extension/entrypoints/background.ts",
    "apps/extension/entrypoints/content.content.ts",
    "apps/extension/package.json",
    "apps/extension/wxt.config.ts",
    "packages/protocol/src/index.ts",
    "packages/protocol/tsconfig.build.json",
    "packages/sync-core/src/index.ts",
    "packages/sync-core/tsconfig.build.json",
    "scripts/package-browser.mjs",
    "scripts/verify-opera-build.mjs",
  ];
  for (const source of requiredSources) {
    assert.ok(sources.has(source), `${sourcesArtifact} is missing ${source}`);
  }
  const forbiddenSources = [".env", "design-qa.md"];
  for (const source of forbiddenSources) {
    assert.ok(!sources.has(source), `${sourcesArtifact} unexpectedly contains ${source}`);
  }
  assert.ok(
    [...sources].every(
      (source) => !source.includes("node_modules/") && !source.includes(".output/"),
    ),
    `${sourcesArtifact} contains generated files or dependencies`,
  );
}

console.log(`Verified Vyzync ${manifest.version} Opera MV3 build.`);
