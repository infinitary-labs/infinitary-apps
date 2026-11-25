import { describe, expect, it } from "vitest";
import { stub } from "../../../../../tests/helpers/githubForgeStub";

// Intent: the captain's report that an approved, clean pull request stayed
// unmerged for over 40 minutes while GitHub answered 409 to every background
// merge request, and the ask that it never happens again. The answers are the
// shapes GitHub documents at API version 2026-03-10: a 409 "returns that
// request's UUID and merge options", and the pending result carries the same
// details.
const MERGE_ASYNC = "/repos/octo/meter/pulls/23/merge-async";
const DIRECT = "/repos/octo/meter/pulls/23/merge";
const UUID = "630b9d5e-1f4c-4e8b-9a6d-2e7b8a900b9f";
const merging = { number: 23, url: null, branch: "b", headSha: "feedbeef", title: "fix: meter" };
const PENDING = {
  status: "pending",
  details: {
    message: "Merge request is in progress.",
    uuid: UUID,
    merge_method: "squash",
    merge_action: "default",
    expected_head_sha: "feedbeef",
    bypass_rules: false,
  },
};

const lines = (seen: { method: string; url: string }[]) =>
  seen.map((request) => `${request.method} ${request.url}`);

describe("a merge request GitHub already holds for the pull request", () => {
  it("reads the request a 409 names once by its id, and answers with that id instead of a bare refusal", async () => {
    const sleeps: number[] = [];
    const { forge, seen } = await stub(
      {
        [`PUT ${MERGE_ASYNC}`]: () => ({ status: 409, json: PENDING }),
        [`GET ${MERGE_ASYNC}/${UUID}`]: () => ({ json: PENDING }),
      },
      sleeps,
    );
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
      message: `GitHub is holding an earlier merge request of #23 (${UUID}) that has not finished, so this one was not taken`,
    });
    expect(lines(seen)).toEqual([`PUT ${MERGE_ASYNC}`, `GET ${MERGE_ASYNC}/${UUID}`]);
    expect(sleeps).toEqual([]);
  });

  it("says GitHub holds a request it did not name, with no id to read", async () => {
    // The reported pull request's own answers: a 409 with no words and no body.
    const { forge, seen } = await stub({ [`PUT ${MERGE_ASYNC}`]: () => ({ status: 409 }) }, []);
    const caught = await forge.putIn(merging, "feedbeef", "squash").catch((error) => error);
    expect(caught).toMatchObject({
      name: "ForgeMergeUnconfirmed",
      held: true,
      message:
        "GitHub is holding an earlier merge request of #23 and did not name it, so this one was not taken",
    });
    expect(caught.mergeTask).toBeUndefined();
    expect(lines(seen)).toEqual([`PUT ${MERGE_ASYNC}`]);
  });

  it("reads a held request that ended without merging as a failure to read the pull request after, never a hold", async () => {
    const { forge } = await stub(
      {
        [`PUT ${MERGE_ASYNC}`]: () => ({ status: 409, json: PENDING }),
        [`GET ${MERGE_ASYNC}/${UUID}`]: () => ({
          json: { status: "failed", details: { message: "Required status check is failing" } },
        }),
      },
      [],
    );
    const caught = await forge.putIn(merging, "feedbeef", "squash").catch((error) => error);
    expect(caught).toMatchObject({
      name: "ForgeError",
      failure: "transient",
      message:
        "the earlier merge request of #23 that GitHub was holding ended without merging (failed), so this one was not taken",
    });
    expect(caught.held).toBeUndefined();
  });

  it("answers a held request GitHub's merge queue took as queued, and keeps the id of one it says merged or cannot read", async () => {
    let held: { status?: number; json?: unknown } = { json: { status: "enqueued", details: {} } };
    const { forge, seen } = await stub(
      {
        [`PUT ${MERGE_ASYNC}`]: () => ({ status: 409, json: PENDING }),
        [`GET ${MERGE_ASYNC}/${UUID}`]: () => held,
      },
      [],
    );
    await expect(forge.putIn(merging, "feedbeef", "squash")).resolves.toEqual({ queued: true });
    held = { json: { status: "merged", details: {} } };
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
      message: `GitHub says an earlier merge request of #23 (${UUID}) merged it, so this one was not taken`,
    });
    held = { status: 500 };
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
    });
    // One request and one read each time, and nothing else.
    expect(lines(seen)).toEqual([
      `PUT ${MERGE_ASYNC}`,
      `GET ${MERGE_ASYNC}/${UUID}`,
      `PUT ${MERGE_ASYNC}`,
      `GET ${MERGE_ASYNC}/${UUID}`,
      `PUT ${MERGE_ASYNC}`,
      `GET ${MERGE_ASYNC}/${UUID}`,
    ]);
  });

  it("keeps the id of a request GitHub took when a read of its result comes back empty or without the id", async () => {
    let answer: { status?: number; json?: unknown } = {};
    const { forge } = await stub(
      {
        [`PUT ${MERGE_ASYNC}`]: () => ({ status: 202, json: PENDING }),
        [`GET ${MERGE_ASYNC}/${UUID}`]: () => answer,
      },
      [],
    );
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
    });
    answer = { json: { status: "pending", details: {} } };
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
    });
  });

  it("calls a direct merge answered with nothing readable unknown, and one GitHub says it did not make refused", async () => {
    let answer: { status?: number; json?: unknown } = {};
    const { forge } = await stub({ [`PUT ${DIRECT}`]: () => answer }, []);
    await expect(forge.putInDirectly(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      failure: "transient",
      message: "GitHub's answer to the merge of #23 could not be read",
    });
    answer = { json: { message: "accepted" } };
    await expect(forge.putInDirectly(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
    });
    answer = { json: { merged: false, message: "Pull Request is not mergeable" } };
    await expect(forge.putInDirectly(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeError",
      failure: "refused",
      message: "GitHub did not confirm the merge of #23: Pull Request is not mergeable",
    });
  });

  it("keeps the id of a request GitHub took when a read of its result fails", async () => {
    const { forge, seen } = await stub(
      {
        [`PUT ${MERGE_ASYNC}`]: () => ({ status: 202, json: PENDING }),
        [`GET ${MERGE_ASYNC}/${UUID}`]: () => ({ status: 500 }),
      },
      [],
    );
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
    });
    expect(lines(seen)).toEqual([`PUT ${MERGE_ASYNC}`, `GET ${MERGE_ASYNC}/${UUID}`]);
  });

  it("keeps the id of a request GitHub took and had not finished when the reads ended", async () => {
    const { forge, seen } = await stub(
      {
        [`PUT ${MERGE_ASYNC}`]: () => ({ status: 202, json: PENDING }),
        [`GET ${MERGE_ASYNC}/${UUID}`]: () => ({ json: PENDING }),
      },
      [],
    );
    await expect(forge.putIn(merging, "feedbeef", "squash")).rejects.toMatchObject({
      name: "ForgeMergeUnconfirmed",
      mergeTask: UUID,
      held: true,
      message: "GitHub had not finished merging #23 when the app stopped reading",
    });
    expect(seen.filter((request) => request.method === "PUT")).toHaveLength(1);
  });

  it("reads how a held request stands by its id, without sending anything", async () => {
    let answer: { status?: number; json?: unknown } = { json: PENDING };
    const { forge, seen } = await stub({ [`GET ${MERGE_ASYNC}/${UUID}`]: () => answer }, []);
    await expect(forge.heldMergeState(23, UUID)).resolves.toEqual({ status: "pending" });
    answer = { json: { status: "merged", details: {} } };
    await expect(forge.heldMergeState(23, UUID)).resolves.toEqual({ status: "merged" });
    answer = { json: { status: "enqueued", details: {} } };
    await expect(forge.heldMergeState(23, UUID)).resolves.toEqual({ status: "queued" });
    answer = {
      json: { status: "failed", details: { message: "Required status check is failing" } },
    };
    await expect(forge.heldMergeState(23, UUID)).resolves.toEqual({
      status: "failed",
      message: "Required status check is failing",
    });
    // GitHub keeps a result for a day, then answers 404 for its id.
    answer = { status: 404, json: { message: "Not Found" } };
    await expect(forge.heldMergeState(23, UUID)).resolves.toEqual({ status: "gone" });
    expect(seen.map((request) => request.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(seen[0]?.headers["x-github-api-version"]).toBe("2026-03-10");
  });

  it("sends the direct merge with the same version, way and commit words as the background one", async () => {
    let answer: { status?: number; json?: unknown } = { json: { merged: true, sha: "squash01" } };
    const { forge, seen } = await stub({ [`PUT ${DIRECT}`]: () => answer }, []);
    await expect(forge.putInDirectly(merging, "feedbeef", "squash")).resolves.toEqual({
      sha: "squash01",
    });
    expect(lines(seen)).toEqual([`PUT ${DIRECT}`]);
    expect(seen[0]?.body).toEqual({
      sha: "feedbeef",
      merge_method: "squash",
      commit_title: "fix: meter",
      commit_message: "",
    });
    // A branch with a merge queue takes no direct merge: GitHub's refusal is the answer.
    answer = {
      status: 405,
      json: { message: "Changes must be made through the merge queue" },
    };
    await expect(forge.putInDirectly(merging, "feedbeef", "squash")).rejects.toMatchObject({
      failure: "refused",
      message: `GitHub answered 405 to PUT ${DIRECT}: Changes must be made through the merge queue`,
    });
  });
});
