import type * as NodeFs from "node:fs";
import { createRequire } from "node:module";

/**
 * The file system without Electron's asar reading. Inside Electron the
 * ordinary `fs` calls treat an `.asar` file as a folder, on a made-up
 * device, so a walk of a folder that holds an installed app or
 * `node_modules/electron` steps into `app.asar`, fails on its links, reads
 * it as a mounted volume, and a recursive delete stops at it. A walk or a
 * delete that must see the file as the file it is reads through
 * `original-fs`: the folder move's copy and its check, and a closed task's
 * cleanup. Outside Electron that is plain `node:fs`.
 */
const plain: typeof NodeFs = process.versions.electron
  ? createRequire(import.meta.url)("original-fs")
  : createRequire(import.meta.url)("node:fs");

export const { createReadStream } = plain;
export const { chmod, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, utimes } =
  plain.promises;
