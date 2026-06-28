#!/usr/bin/env node
import { build } from "esbuild";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = join(rootDir, "dist");
const bundlePath = join(distDir, "ao.bundle.mjs");
const wrapperPath = join(distDir, "ao");
const cmdPath = join(distDir, "ao.cmd");

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(rootDir, "tools/build/cli-entry.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  sourcemap: false,
  logLevel: "info",
  external: ["fsevents"],
});

// Unix wrapper: POSIX sh only — do not invoke on Windows; use ao.cmd instead.
// ${0%/*} resolves the wrapper's own directory without requiring readlink, works on Linux and macOS.
writeFileSync(
  wrapperPath,
  '#!/usr/bin/env sh\n# POSIX sh only — do not invoke on Windows; use ao.cmd instead\nexec node "${0%/*}/ao.bundle.mjs" "$@"\n',
);
chmodSync(wrapperPath, 0o755);

// Windows wrapper
writeFileSync(cmdPath, "@echo off\nnode \"%~dp0ao.bundle.mjs\" %*\n");

console.log(`Built bundle: ${bundlePath}`);
console.log(`Wrote Unix wrapper: ${wrapperPath}`);
console.log(`Wrote Windows wrapper: ${cmdPath}`);
