import { describe, expect, it } from "vitest";
import { batchAnswerSchema, keepsCommits, type MergeWays, mergeWayFor } from "./batches";
import { ownsBatches, type RepoView } from "./repos";

// Intent: the captain's approved plan for batches of their own, piece 1: a batch merges
// keeping one commit per change, by a rebase merge where the project allows it and a
// merge commit otherwise; a project that allows only squash merges is not offered them.

const EVERY_WAY: MergeWays = { squash: true, rebase: true, merge: true };

describe("the merge a batch takes, from what the project's host allows", () => {
  it("keeps one commit per change by a rebase merge where the project allows it", () => {
    expect(mergeWayFor(EVERY_WAY, 2)).toBe("rebase");
    expect(mergeWayFor({ squash: false, rebase: true, merge: false }, 3)).toBe("rebase");
  });

  it("takes a merge commit where rebase merges are turned off", () => {
    expect(mergeWayFor({ squash: true, rebase: false, merge: true }, 2)).toBe("merge");
  });

  it("finds no merge for several changes where only squash merges are allowed", () => {
    const squashOnly = { squash: true, rebase: false, merge: false };
    expect(mergeWayFor(squashOnly, 2)).toBeUndefined();
    expect(keepsCommits(squashOnly)).toBe(false);
    expect(keepsCommits(EVERY_WAY)).toBe(true);
    expect(keepsCommits({ squash: false, rebase: false, merge: true })).toBe(true);
  });

  it("merges a batch of one as that change's own pull request merges today, by squash", () => {
    expect(mergeWayFor(EVERY_WAY, 1)).toBe("squash");
    // Where squash merges are off, one commit is still one commit.
    expect(mergeWayFor({ squash: false, rebase: true, merge: true }, 1)).toBe("rebase");
    expect(mergeWayFor({ squash: false, rebase: false, merge: true }, 1)).toBe("merge");
  });
});

describe("a by-hand answer to a held batch", () => {
  const head = "5f0c2a9e41b7d3c8a6e2f9b0d4c1a7e3b8f6d2c0";

  it("sends several changes back, each with its own reason", () => {
    const answer = batchAnswerSchema.parse({
      action: "send-back",
      head,
      changes: [
        { taskId: "t-parser", reason: "Its new parser fails the date tests the batch ran." },
        { taskId: "t-export", reason: " The export reads a column the parser renamed. " },
      ],
    });
    expect(answer).toMatchObject({
      changes: [
        { taskId: "t-parser" },
        { taskId: "t-export", reason: "The export reads a column the parser renamed." },
      ],
    });
  });

  it("refuses a send-back that names no change or gives no reason", () => {
    expect(batchAnswerSchema.safeParse({ action: "send-back", head, changes: [] }).success).toBe(
      false,
    );
    expect(
      batchAnswerSchema.safeParse({
        action: "send-back",
        head,
        changes: [{ taskId: "t-parser", reason: "   " }],
      }).success,
    ).toBe(false);
  });
});

describe("which batched projects get batches of the person's own", () => {
  const github: RepoView["host"] = { kind: "github", name: "github.com" };

  it("is every batched project that carries no team queue file, once its files were read", () => {
    expect(ownsBatches("queue-pr", { host: github, queueWorkflows: [] })).toBe(true);
    expect(
      ownsBatches("queue-pr", { host: { kind: "gitlab", name: "gitlab.com" }, queueWorkflows: [] }),
    ).toBe(true);
  });

  it("keeps the team queue on a project that still carries its files, on or off", () => {
    expect(
      ownsBatches("queue-pr", {
        host: github,
        queueWorkflows: [{ path: ".github/workflows/batch.yml", active: false }],
      }),
    ).toBe(false);
  });

  it("is unknown, never guessed, while the project's files were never read", () => {
    expect(ownsBatches("queue-pr", { host: github })).toBeUndefined();
  });

  it("is never a direct or local project, nor a host with no pull requests to batch", () => {
    expect(ownsBatches("direct-pr", { host: github, queueWorkflows: [] })).toBe(false);
    expect(ownsBatches("local-only", { host: github, queueWorkflows: [] })).toBe(false);
    expect(
      ownsBatches("queue-pr", {
        host: { kind: "git", name: "git.example.com" },
        queueWorkflows: [],
      }),
    ).toBe(false);
  });
});
