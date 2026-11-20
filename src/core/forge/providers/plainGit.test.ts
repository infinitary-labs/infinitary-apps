import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../../tests/helpers/scratchDirs";
import { createForgeResolver } from "../index";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../../utilityQos", async (importOriginal) =>
  (await import("../../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * A plain Git host, end to end against real repositories (git integration
 * PR 1.1, the captain's Q4): the working copy is sent up as its own branch,
 * reads green with no checks, and putting it in fast-forwards the host's
 * default branch - never forced, never at a head nobody checked.
 */

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    .toString()
    .trim();

/** A bare host, a clone of it with one commit on main, and a task branch with one more. */
function plainHost() {
  const root = scratchDir("infinitary-plain-host-");
  const bare = join(root, "host.git");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "pipe" });
  execFileSync("git", ["clone", bare, repo], { stdio: "pipe" });
  run(repo, "config", "user.name", "Test");
  run(repo, "config", "user.email", "test@localhost");
  run(repo, "commit", "--allow-empty", "-m", "init");
  run(repo, "push", "origin", "HEAD:refs/heads/main");
  run(repo, "checkout", "-b", "fm/task-1");
  writeFileSync(join(repo, "fix.txt"), "the fix\n");
  run(repo, "add", "fix.txt");
  run(repo, "commit", "-m", "fix");
  const head = run(repo, "rev-parse", "HEAD");
  const forgeFor = createForgeResolver({ github: () => expect.fail("not a GitHub project") });
  const origin = "ssh://git@git.example.com/me/meter.git";
  run(repo, "config", `url.${bare}.insteadOf`, origin);
  run(repo, "remote", "set-url", "origin", origin);
  const forge = forgeFor({
    path: repo,
    origin,
    host: { kind: "git", name: "git.example.com" },
  });
  return { bare, repo, head, forge };
}

describe("the forge resolver", () => {
  it("serves each kind: this Mac, the bound GitHub, and a plain host by its name", () => {
    const github = vi.fn(() => ({ kind: "github" }) as never);
    const forgeFor = createForgeResolver({ github });
    expect(forgeFor(undefined).kind).toBe("none");
    expect(forgeFor({ path: "/r", origin: null, host: null })).toMatchObject({
      kind: "none",
      place: null,
    });
    forgeFor({
      path: "/r",
      origin: "git@github.com:octo/meter.git",
      host: { kind: "github", name: "github.com" },
    });
    expect(github).toHaveBeenCalledWith({
      kind: "github",
      host: "github.com",
      owner: "octo",
      name: "meter",
      dir: "/r",
    });
    // GitLab is recognised by name and behaves as a plain host until its file exists.
    expect(
      forgeFor({
        path: "/r",
        origin: "https://gitlab.com/group/meter.git",
        host: { kind: "gitlab", name: "gitlab.com" },
      }),
    ).toMatchObject({ kind: "gitlab", place: "GitLab" });
    expect(
      forgeFor({ path: "/r", origin: "/Users/me/host.git", host: { kind: "git", name: null } }),
    ).toMatchObject({ kind: "git", place: null });
  });
});

describe("PlainGitForge", () => {
  it("sends the working copy up as its own branch, with no checks, named by its branch", async () => {
    const { bare, head, forge } = plainHost();
    expect(forge.place).toBe("git.example.com");
    await expect(forge.changeFor("fm/task-1")).resolves.toBeNull();
    const sent = await forge.openChange({ branch: "fm/task-1", title: "Fix", body: "Why" });
    expect(sent).toEqual({ branch: "fm/task-1", headSha: head, url: null });
    expect(run(bare, "rev-parse", "refs/heads/fm/task-1")).toBe(head);
    expect(await forge.changeFor("fm/task-1")).toEqual(sent);
    expect(await forge.checks(sent)).toEqual({ items: [] });
    expect(forge.label(sent)).toBe("fm/task-1");
    expect(forge.url(sent)).toBeNull();
    expect(await forge.defaultBranch()).toBe("main");
  });

  it("puts it in by fast-forwarding the host's default branch onto the checked head", async () => {
    const { bare, head, forge } = plainHost();
    const sent = await forge.openChange({ branch: "fm/task-1", title: "Fix", body: "" });
    await forge.putIn(sent, head, undefined);
    expect(run(bare, "rev-parse", "refs/heads/main")).toBe(head);
  });

  it("refuses a head nobody checked, and a default branch that moved on, without forcing", async () => {
    const { bare, repo, head, forge } = plainHost();
    const sent = await forge.openChange({ branch: "fm/task-1", title: "Fix", body: "" });
    await expect(
      forge.putIn(sent, "0000000000000000000000000000000000000000", undefined),
    ).rejects.toMatchObject({ failure: "refused" });

    // Someone else put work in on main meanwhile.
    run(repo, "checkout", "-b", "other", "origin/main");
    run(repo, "commit", "--allow-empty", "-m", "someone else");
    run(repo, "push", "origin", "HEAD:refs/heads/main");
    const moved = run(bare, "rev-parse", "refs/heads/main");
    await expect(forge.putIn(sent, head, undefined)).rejects.toMatchObject({ failure: "refused" });
    expect(run(bare, "rev-parse", "refs/heads/main")).toBe(moved);
  });

  it("refuses publication and merge through a former push address even when reads use the approved one", async () => {
    const { bare, repo, head, forge } = plainHost();
    const former = join(scratchDir("former-plain-host-"), "host.git");
    run(repo, "clone", "--bare", bare, former);
    const readMain = (dir: string) => run(dir, "rev-parse", "refs/heads/main");
    const base = readMain(bare);
    const refusal = {
      failure: "refused",
      message: expect.stringContaining("read and push addresses"),
    };
    run(repo, "remote", "set-url", "--push", "origin", former);
    await expect(
      forge.openChange({ branch: "fm/task-1", title: "Fix", body: "" }),
    ).rejects.toMatchObject(refusal);
    expect(await forge.changeFor("fm/task-1")).toBeNull();
    expect(() => run(former, "rev-parse", "--verify", "refs/heads/fm/task-1")).toThrow();
    run(repo, "config", "--unset-all", "remote.origin.pushurl");
    const sent = await forge.openChange({ branch: "fm/task-1", title: "Fix", body: "" });
    run(repo, "remote", "set-url", "--push", "origin", former);
    await expect(forge.putIn(sent, head, undefined)).rejects.toMatchObject(refusal);
    expect(readMain(bare)).toBe(base);
    expect(readMain(former)).toBe(base);
    run(repo, "config", "--unset-all", "remote.origin.pushurl");
    await forge.putIn(sent, head, undefined);
    const result = { approvedMain: readMain(bare), formerMain: readMain(former) };
    if (process.env.INFINITARY_CUTOVER_PROOF === "1")
      console.info(
        JSON.stringify({
          action: "plain Git writes with split then matching routes",
          base,
          head,
          result,
        }),
      );
    expect(result).toEqual({ approvedMain: head, formerMain: base });
  });

  it("takes a sent-up copy back on close, quietly when it is already gone", async () => {
    const { bare, forge } = plainHost();
    const sent = await forge.openChange({ branch: "fm/task-1", title: "Fix", body: "" });
    await forge.close(sent);
    expect(() => run(bare, "rev-parse", "--verify", "refs/heads/fm/task-1")).toThrow();
    await expect(forge.close(sent)).resolves.toBeUndefined();
  });

  it("is transient when the host cannot be reached", async () => {
    const { repo } = plainHost();
    run(repo, "remote", "set-url", "origin", "http://127.0.0.1:9/me/meter.git");
    const forge = createForgeResolver({ github: () => expect.fail("not GitHub") })({
      path: repo,
      origin: "http://127.0.0.1:9/me/meter.git",
      host: { kind: "git", name: "127.0.0.1" },
    });
    await expect(forge.changeFor("fm/task-1")).rejects.toMatchObject({ failure: "transient" });
  });
});
