import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type BuildIdentity, buildIdentitySchema } from "@shared/buildIdentity";
import type { HomeSource } from "../connection/connection";
import { hostEnv } from "../hostEnv";
import type { StarterSession } from "../update/devStarter";

/**
 * This Mac's own build when `pnpm dev`'s starter started it (docs/devices.md,
 * "Matching the home's build"): the commit it read at that start, whether
 * tracked files were edited from it, and its lockfile's digest. An edited
 * run still names its commit: a computer matched to it builds that commit,
 * never the edits.
 */
export function starterBuild(session: StarterSession): BuildIdentity {
  return buildIdentitySchema.parse({
    commit: session.commit,
    source: {
      edited: session.edited,
      ...(/^[a-f0-9]{64}$/.test(session.lockDigest) ? { lockDigest: session.lockDigest } : {}),
    },
  });
}

/**
 * What this Mac sends a computer it asks to build its source
 * (`ConnectionOptions.source`): the committed tree at the starter's commit,
 * as one gzipped tar `git archive` makes as it is sent, from the copy the
 * starter runs. Uncommitted edits are never in it.
 */
export function homeSourceOf(session: Pick<StarterSession, "root" | "commit">): HomeSource {
  return {
    commit: session.commit,
    archive: () => {
      const git = spawn("git", ["archive", "--format=tar.gz", session.commit], {
        cwd: session.root,
        env: hostEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      const ended = new Promise<void>((resolve, reject) => {
        git.once("error", reject);
        git.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`Packing the source stopped (${code}).`)),
        );
      });
      return {
        stream: git.stdout as Readable,
        ended,
        stop: () => {
          if (git.exitCode === null) git.kill();
        },
      };
    },
  };
}
