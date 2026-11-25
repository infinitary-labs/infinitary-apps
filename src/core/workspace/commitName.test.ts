import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv, withTaskShell } from "../hostEnv";
import { resolveCommitName, withCommitName } from "./commitName";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * INF-6779's approved plan, part 1: a crew commit carries the name the
 * computer's saved git settings give, or Infinitary when they give none, and
 * a command that passes a stand-in name with `-c` cannot replace it.
 */
describe("a crewmate session's commit name", () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = scratchDir("infinitary-commit-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    for (const name of ["AUTHOR", "COMMITTER"]) {
      vi.stubEnv(`GIT_${name}_NAME`, undefined);
      vi.stubEnv(`GIT_${name}_EMAIL`, undefined);
    }
    vi.stubEnv("EMAIL", undefined);
    repo = scratchDir("infinitary-commit-repo-");
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A commit made the way the old served sentence told crewmates to, in the session's shell. */
  async function commitWithStandIn(): Promise<string> {
    const shell = withCommitName(undefined, await resolveCommitName(repo));
    const env = withTaskShell(hostEnv(), shell);
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=Crewmate",
        "-c",
        "user.email=crew@infinitary.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "work",
      ],
      { env },
    );
    return execFileSync("git", ["-C", repo, "log", "-1", "--format=%an <%ae> | %cn <%ce>"], {
      encoding: "utf8",
    }).trim();
  }

  it("commits under the person's saved name whatever name the command passes", async () => {
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
    );

    expect(await commitWithStandIn()).toBe(
      "Ada Lovelace <ada@example.com> | Ada Lovelace <ada@example.com>",
    );
  });

  it("commits as Infinitary on a computer with no saved name", async () => {
    expect(await commitWithStandIn()).toBe(
      "Infinitary <infinitary@localhost> | Infinitary <infinitary@localhost>",
    );
  });
});
