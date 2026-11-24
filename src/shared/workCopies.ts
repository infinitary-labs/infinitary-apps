import { z } from "zod";
import { commitSchema } from "./workIdentity";

/** The commit a task's working copy started from, and whether it was fetched first. */
export const dispatchBaseSchema = z.object({
  sha: z.string(),
  ref: z.string(),
  fetch: z.enum(["fetched", "failed", "none"]),
  fetchError: z.string().optional(),
});

/** What a task's work saved as one commit on its kept ref before its working copy goes. */
export const keptWorkSchema = z.object({
  ref: z.string().min(1).max(256),
  sha: commitSchema,
  dirty: z.boolean(),
  unlandedCommits: z.number().int().nonnegative(),
});

/** A git bundle waiting there to be read home (`inf:working-copy:read`). */
export const bundleSchema = z.object({
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Which of a task's refs a bundle carries: its branch, or the commit its work was kept in. */
export const bundledRefSchema = z.enum(["branch", "kept"]);
export type BundledRef = z.infer<typeof bundledRefSchema>;

/** What `read` reads: a bundle, or the pack of a task that moves. */
export const readableRefSchema = z.enum(["branch", "kept", "move"]);
export type ReadableRef = z.infer<typeof readableRefSchema>;
