import { describe, expect, it } from "vitest";
import { type Route, stub } from "../../../../../tests/helpers/githubForgeStub";

// Intent: the approved plan's piece 5, "the merge call goes through GitHub's
// background merge (merge-async, merge_action default)", so a branch with a
// merge queue takes the pull request. The answers are the shapes GitHub
// documents for the call and for reading its result.
const MERGE_ASYNC = "/repos/octo/meter/pulls/23/merge-async";
const merging = { number: 23, url: null, branch: "b", headSha: "feedbeef", title: "fix: meter" };
/** GitHub accepts the merge to run in the background, then answers `result` when its id is read. */
const background = (result: () => unknown, uuid = "0b9f7d3a-52c1-4e8b-9a6d-1f4c2e7b8a90") => ({
  [`PUT ${MERGE_ASYNC}`]: () => ({
    status: 202,
    json: {
      status: "pending",
      details: {
        uuid,
        merge_method: "squash",
        merge_action: "default",
        expected_head_sha: "feedbeef",
        bypass_rules: false,
      },
    },
  }),
  [`GET ${MERGE_ASYNC}/${uuid}`]: () => ({ json: result() }),
});

describe("a merge on GitHub", () => {
  it("sends a merge as GitHub's background merge with its own choice of action, and answers the commit it made", async () => {
    const sleeps: number[] = [];
    const { forge, seen } = await stub(
      background(() => ({
        status: "merged",
        details: { message: "Pull request merged", sha: "squash01" },
      })),
      sleeps,
    );
    await expect(forge.putIn(merging, "feedbeef")).resolves.toEqual({ sha: "squash01" });
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PUT ${MERGE_ASYNC}`,
      `GET ${MERGE_ASYNC}/0b9f7d3a-52c1-4e8b-9a6d-1f4c2e7b8a90`,
    ]);
    // No action is named: GitHub's default merges directly where the branch has no merge queue.
    expect(seen[0]?.body).toEqual({
      sha: "feedbeef",
      merge_method: "squash",
      commit_title: "fix: meter",
      commit_message: "",
    });
    expect(seen[0]?.headers["x-github-api-version"]).toBe("2026-03-10");
    expect(sleeps).toHaveLength(1);
  });

  it("answers a pull request the branch's merge queue took as queued, never as merged", async () => {
    const { forge } = await stub(
      background(() => ({
        status: "enqueued",
        details: { message: "Pull request added to the merge queue" },
      })),
      [],
    );
    await expect(forge.putIn(merging, "feedbeef")).resolves.toEqual({ queued: true });
  });

  // GitHub's own answer, read on a real branch with a merge queue, to the
  // request above: the queue merges its own way and writes its own words.
  const QUEUE_REFUSAL = "Custom merge params are not supported when merging via a merge queue";
  /** A branch with a merge queue: the request naming a merge method fails with `QUEUE_REFUSAL`, and the version alone gets `result`. */
  const queueBranch = (result: () => unknown): Record<string, Route> => {
    const id = (seen: { body: unknown }) =>
      (seen.body as { merge_method?: string }).merge_method ? "named" : "alone";
    return {
      [`PUT ${MERGE_ASYNC}`]: (seen) => ({
        status: 202,
        json: { status: "pending", details: { uuid: id(seen) } },
      }),
      [`GET ${MERGE_ASYNC}/named`]: () => ({
        json: { status: "failed", details: { message: QUEUE_REFUSAL } },
      }),
      [`GET ${MERGE_ASYNC}/alone`]: () => ({ json: result() }),
    };
  };

  it("sends the version alone to the merge queue once GitHub refuses the merge method and commit words there", async () => {
    const { forge, seen } = await stub(
      queueBranch(() => ({
        status: "enqueued",
        details: { message: "Pull request added to the merge queue" },
      })),
      [],
    );
    await expect(forge.putIn(merging, "feedbeef")).resolves.toEqual({ queued: true });
    const sent = seen.filter((request) => request.method === "PUT");
    expect(sent.map((request) => request.body)).toEqual([
      { sha: "feedbeef", merge_method: "squash", commit_title: "fix: meter", commit_message: "" },
      // The queue by name: this request can enter the queue or be refused, never merge another way.
      { sha: "feedbeef", merge_action: "merge_queue" },
    ]);
    expect(sent[1]?.headers["x-github-api-version"]).toBe("2026-03-10");
  });

  it("refuses with the merge queue's own words when it does not take the version either, and asks no third time", async () => {
    const said = "Head branch was modified. Review and try the merge again.";
    const { forge, seen } = await stub(
      queueBranch(() => ({ status: "failed", details: { message: said } })),
      [],
    );
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      failure: "refused",
      message: `GitHub did not merge #23: ${said}`,
    });
    expect(seen.filter((request) => request.method === "PUT")).toHaveLength(2);
  });

  it("answers a pull request already in the merge queue as queued, with nothing to read after", async () => {
    const { forge, seen } = await stub({
      [`PUT ${MERGE_ASYNC}`]: () => ({ json: { status: "enqueued", details: {} } }),
    });
    await expect(forge.putIn(merging, "feedbeef")).resolves.toEqual({ queued: true });
    expect(seen).toHaveLength(1);
  });

  it("refuses with GitHub's own words when the background merge failed, and types a moved main branch", async () => {
    // The captain's ask: retry on its own right away when GitHub says main
    // moved, and need a crewmate only for a conflict.
    let said = "Head branch was modified. Review and try the merge again.";
    const { forge } = await stub(
      background(() => ({ status: "failed", details: { message: said } })),
      [],
    );
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      name: "ForgeError",
      failure: "refused",
      message: `GitHub did not merge #23: ${said}`,
    });
    said = "Base branch was modified. Review and try the merge again.";
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      name: "ForgeBaseMoved",
      failure: "refused",
      message: `GitHub did not merge #23: ${said}`,
    });
  });

  it("calls a merge still running when its reads end unknown, and one GitHub is still running the same", async () => {
    const sleeps: number[] = [];
    const routes: Record<string, Route> = background(
      () => ({ status: "pending", details: { uuid: "still" } }),
      "still",
    );
    const { forge, seen } = await stub(routes, sleeps);
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      failure: "transient",
      message: "GitHub had not finished merging #23 when the app stopped reading",
    });
    // Sent once, then only read.
    expect(seen.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(seen.filter((request) => request.method === "GET")).toHaveLength(sleeps.length);
    expect(sleeps.length).toBeGreaterThan(1);
    // GitHub's answer to a second request while the first still runs.
    routes[`PUT ${MERGE_ASYNC}`] = () => ({
      status: 409,
      json: { message: "A merge request is already pending for this pull request" },
    });
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({ failure: "transient" });
    // A version that moved is GitHub's verdict, never a merge still running.
    routes[`PUT ${MERGE_ASYNC}`] = () => ({
      status: 409,
      json: { message: "Head branch was modified. Review and try the merge again." },
    });
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({ failure: "refused" });
  });

  it("merges directly on a GitHub that does not know the background merge, and takes that merge only when GitHub says it merged", async () => {
    // An Enterprise Server before the call answers 404 to it: nothing was
    // sent on, so the direct merge it has always had is asked instead.
    let answer: { status?: number; json: unknown } = { json: { merged: true, sha: "squash01" } };
    const { forge, seen } = await stub({
      "PUT /repos/octo/meter/pulls/23/merge": () => answer,
    });
    await expect(forge.putIn(merging, "feedbeef")).resolves.toEqual({ sha: "squash01" });
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PUT ${MERGE_ASYNC}`,
      "PUT /repos/octo/meter/pulls/23/merge",
    ]);
    expect(seen[1]?.body).toEqual(seen[0]?.body);
    answer = { json: { merged: false, message: "Base branch was modified" } };
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      failure: "refused",
      message: "GitHub did not confirm the merge of #23: Base branch was modified",
    });
    const refusal = "Base branch was modified. Review and try the merge again.";
    answer = { status: 405, json: { message: refusal } };
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      name: "ForgeBaseMoved",
      failure: "refused",
      message: `GitHub answered 405 to PUT /repos/octo/meter/pulls/23/merge: ${refusal}`,
    });
    answer = { status: 405, json: { message: "Pull Request has merge conflicts" } };
    await expect(forge.putIn(merging, "feedbeef")).rejects.toMatchObject({
      name: "ForgeError",
      failure: "refused",
    });
  });

  it("reads whether GitHub's merge queue holds a pull request, and never guesses from an answer that does not say", async () => {
    let answer: unknown = { data: { repository: { pullRequest: { isInMergeQueue: true } } } };
    const { forge, seen } = await stub({ "POST /graphql": () => ({ json: answer }) });
    expect(await forge.inHostQueue(23)).toBe(true);
    expect(seen[0]?.body).toMatchObject({
      variables: { owner: "octo", name: "meter", number: 23 },
    });
    answer = { data: { repository: { pullRequest: { isInMergeQueue: false } } } };
    expect(await forge.inHostQueue(23)).toBe(false);
    answer = { data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND" }] };
    await expect(forge.inHostQueue(23)).rejects.toMatchObject({ failure: "transient" });
  });
});
