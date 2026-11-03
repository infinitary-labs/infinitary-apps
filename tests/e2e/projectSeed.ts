/**
 * INF-2394: fixture ownership follows the product reader.
 * @journey-area src/core/workspace/
 */
import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { hostEnv } from "../../src/core/hostEnv";
import type { AppDatabase } from "../../src/core/storage/db";

/**
 * Complete a seeded hosted project: its saved address also exists in its
 * scratch git folder, and the folder knows origin's default branch the way a
 * clone does. Without that, every merge's folder refresh is refused and
 * files a "Bring the folder up to date" task the journey never asked for
 * (INF-549, docs/task-record.md "A folder a merge left behind").
 */
export function seedHostedOrigins(db: AppDatabase, userDataDir: string): void {
  const rows = db.prepare("SELECT path, origin FROM repos WHERE origin IS NOT NULL").all() as {
    path: string;
    origin: string;
  }[];
  for (const row of rows) {
    const inside = relative(resolve(userDataDir), resolve(row.path));
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`))
      throw new Error("A hosted project fixture must own a folder inside its scratch data.");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", row.path, ...args], { env: hostEnv(), stdio: "pipe" })
        .toString()
        .trim();
    if (!git("remote").split("\n").includes("origin")) {
      git("remote", "add", "origin", row.origin);
      // Dispatch fetches the real default branch through a scratch-local mirror.
      git("config", `url.${row.path}.insteadOf`, row.origin);
      // The mirror is the folder itself, so its default branch is the one checked out.
      git("fetch", "--quiet", "origin");
      git("remote", "set-head", "origin", "--auto");
    } else if (git("config", "--get", "remote.origin.url") !== row.origin)
      throw new Error("The hosted project fixture's saved address and git address disagree.");
  }
}
