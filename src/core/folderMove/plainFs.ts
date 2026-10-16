import type * as NodeFs from "node:fs";
import { createRequire } from "node:module";

/**
 * The file system without Electron's asar reading. Inside Electron the
 * ordinary `fs` calls treat an `.asar` file as a folder, so a walk of a data
 * folder that holds an installed app steps into `app.asar` and fails on its
 * links. The move copies and checks the file as the file it is, so its walks
 * and its copy read through `original-fs`; outside Electron that is plain `node:fs`.
 */
const plain: typeof NodeFs = process.versions.electron
  ? createRequire(import.meta.url)("original-fs")
  : createRequire(import.meta.url)("node:fs");

export const { createReadStream } = plain;
export const { chmod, cp, lstat, mkdir, readdir, readlink, rm, utimes } = plain.promises;
