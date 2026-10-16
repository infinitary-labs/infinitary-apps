// Copies the onnxruntime-web WASM files that transformers.js needs for
// WebGPU into a generated dir the renderer worker imports with `?url`
// (hi-bit's build gotcha, verified there). ORT's package `exports` map
// blocks deep `dist/*` imports, and the CSP blocks ORT's default jsdelivr
// CDN, so they must be served from `self`.
//
// Each file is a clone of the installed package's own (scripts/clone-or-copy.ts),
// so on APFS every working copy shares the 24 MB WASM file's blocks with the
// package store instead of holding its own; a disk that cannot clone gets a
// plain copy. A clone cannot land on an existing file, so each one is made
// under a temporary name and renamed over the last run's.
//
// transformers.js 4.x (`onnxruntime-web/webgpu`) loads the *asyncify* build
// on non-Safari (which Electron always is). Keep this list in sync if that
// changes.
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloneOrCopy } from "./clone-or-copy.ts";

export const FILES = ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// onnxruntime-web is a (non-hoisted, pnpm) dependency of
// @huggingface/transformers and neither package exposes `./package.json`
// via its `exports` map, so resolve ORT's main entry from transformers' own
// resolution context and walk to `dist`.
export function ortDist() {
  const require = createRequire(import.meta.url);
  const fromTransformers = createRequire(require.resolve("@huggingface/transformers"));
  return dirname(fromTransformers.resolve("onnxruntime-web"));
}

export function copyOrtAssets({
  from = ortDist(),
  outDir = join(repoRoot, "src", "renderer", "src", "generated", "ort"),
} = {}) {
  mkdirSync(outDir, { recursive: true });
  for (const file of FILES) {
    const target = join(outDir, file);
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    cloneOrCopy(join(from, file), partial);
    renameSync(partial, target);
  }
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = copyOrtAssets();
  console.log(`[infinitary] copied ${FILES.length} onnxruntime-web asset(s) to ${outDir}`);
}
