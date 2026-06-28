#!/usr/bin/env node
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = join(rootDir, "dist");
const publicDir = join(rootDir, "src/ui/public");
const bundlePath = join(distDir, "ao.bundle.mjs");
const seaConfigPath = join(distDir, "sea-config.json");

const platform = process.env.AO_PLATFORM ?? process.platform;
const arch = process.env.AO_ARCH ?? process.arch;
const nodeBinary = process.env.NODE_SEA_NODE ?? process.execPath;
const outputName =
  process.env.AO_SEA_OUTPUT ??
  (platform === "win32" ? join(distDir, "ao.exe") : join(distDir, "ao"));

mkdirSync(distDir, { recursive: true });

function collectUiAssets(dir, keyPrefix = "ui") {
  /** @type {Record<string, string>} */
  const assets = {};
  for (const name of readdirSync(dir).sort()) {
    const fullPath = join(dir, name);
    const key = `${keyPrefix}/${name}`;
    if (statSync(fullPath).isDirectory()) {
      Object.assign(assets, collectUiAssets(fullPath, key));
    } else {
      assets[key] = fullPath;
    }
  }
  return assets;
}

await build({
  entryPoints: [join(rootDir, "tools/build/cli-entry.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  sourcemap: false,
  logLevel: "info",
  external: ["playwright", "playwright-core", "fsevents", "chromium-bidi"],
});

const assets = collectUiAssets(publicDir);
const seaConfig = {
  main: bundlePath,
  mainFormat: "module",
  executable: nodeBinary,
  output: outputName,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
};

writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`);
execFileSync(nodeBinary, ["--build-sea", seaConfigPath], {
  stdio: "inherit",
});

if (platform === "darwin") {
  const entitlementsPath = join(rootDir, "tools/build/sea-entitlements.plist");
  execFileSync(
    "codesign",
    ["--sign", "-", "--force", "--entitlements", entitlementsPath, outputName],
    { stdio: "inherit" },
  );
}

const manifest = {
  platform,
  arch,
  output: outputName,
  bundle: bundlePath,
  assetCount: Object.keys(assets).length,
  node: process.version,
  nodeBinary,
};

writeFileSync(join(distDir, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${outputName} for ${platform}-${arch}`);
