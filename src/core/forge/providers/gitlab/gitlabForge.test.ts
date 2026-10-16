import { describe, expect, it, vi } from "vitest";
import { GitLabForge } from "./gitlabForge";

/**
 * The GitLab forge's reading of answers the stand-in (`tests/gitlabStub.test.ts`)
 * does not script: every `detailed_merge_status` GitLab documents and the
 * older `merge_status`, a merge GitLab answers before it finishes, and a 401
 * GitLab sends a key that may not accept the merge.
 */

const HOST = "gitlab.example.com";
const KEY = "glpat-disposable-test-key";
/** The project's API path as the forge names it in a refusal: relative to the API. */
const PROJECT = `/projects/${encodeURIComponent("group/subgroup/app")}`;

const request = (fields: Record<string, unknown> = {}) => ({
  iid: 4,
  project_id: 7,
  source_project_id: 7,
  source_branch: "fm/task-1",
  target_branch: "main",
  title: "fix: the meter",
  description: "Why",
  web_url: `https://${HOST}/group/subgroup/app/-/merge_requests/4`,
  state: "opened",
  sha: "a".repeat(40),
  ...fields,
});

function forgeAnswering(answer: (method: string, path: string) => Response) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) =>
    answer(init?.method ?? "GET", new URL(String(input)).pathname),
  );
  const rejected = vi.fn();
  const forge = new GitLabForge(
    { kind: "gitlab", host: HOST, owner: "group/subgroup", name: "app", dir: "/r" },
    {
      token: async () => KEY,
      apiBaseUrl: `https://${HOST}/api/v4`,
      fetch: fetcher,
      onSignInRejected: rejected,
    },
  );
  return { forge, fetcher, rejected };
}

describe("GitLabForge", () => {
  it.each([
    [{ detailed_merge_status: "mergeable" }, "clean"],
    [{ detailed_merge_status: "conflict" }, "conflict"],
    [{ detailed_merge_status: "mergeable", has_conflicts: true }, "conflict"],
    [{ detailed_merge_status: "need_rebase" }, "behind"],
    [{ detailed_merge_status: "draft_status" }, "draft"],
    [{ detailed_merge_status: "mergeable", draft: true }, "draft"],
    [{ detailed_merge_status: "not_approved" }, "blocked"],
    [{ detailed_merge_status: "discussions_not_resolved" }, "blocked"],
    [{ detailed_merge_status: "ci_must_pass" }, "blocked"],
    [{ detailed_merge_status: "ci_still_running" }, "blocked"],
    [{ detailed_merge_status: "checking" }, "computing"],
    [{ detailed_merge_status: "unchecked" }, "computing"],
    [{ detailed_merge_status: "a status from a newer GitLab" }, "computing"],
    [{ merge_status: "can_be_merged" }, "clean"],
    [{ merge_status: "cannot_be_merged" }, "conflict"],
    [{ merge_status: "checking" }, "computing"],
  ])("reads %j as %s", async (fields, readiness) => {
    const { forge } = forgeAnswering(() => Response.json(request(fields)));
    expect((await forge.pull(4)).readiness).toBe(readiness);
  });

  it("takes a merge GitLab finished after it answered, waits on one it is still making, and refuses one it never finished", async () => {
    let after: "merged" | "locked" | "failed" = "merged";
    const { forge } = forgeAnswering((method) =>
      method === "PUT"
        ? Response.json(request())
        : Response.json(
            after === "merged"
              ? request({ state: "merged", merge_commit_sha: "b".repeat(40) })
              : after === "locked"
                ? request({ state: "locked" })
                : request({ merge_error: "The merge could not be finished" }),
          ),
    );
    const change = {
      number: 4,
      url: null,
      branch: "fm/task-1",
      headSha: "a".repeat(40),
      title: "fix: the meter",
      body: "Why",
    };
    expect(await forge.putIn(change, change.headSha)).toEqual({ sha: "b".repeat(40) });
    after = "locked";
    // Still merging is no verdict: a transient failure the merge reads back.
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "transient",
    });
    expect(await forge.pull(4)).toMatchObject({ state: "open", readiness: "computing" });
    after = "failed";
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "refused",
      message: `${HOST} did not confirm the merge of !4: The merge could not be finished`,
    });
  });

  it("reads GitLab's 401 on a merge as a permission while GitLab still answers for the key", async () => {
    let keyAccepted = true;
    const { forge, fetcher, rejected } = forgeAnswering((_method, path) => {
      if (path === "/api/v4/user") {
        return keyAccepted
          ? Response.json({ username: "octo" })
          : Response.json({ message: "401 Unauthorized" }, { status: 401 });
      }
      return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    });
    const change = {
      number: 4,
      url: null,
      branch: "fm/task-1",
      headSha: "a".repeat(40),
      title: "fix: the meter",
      body: "",
    };
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "permission",
      message: `${HOST} answered 401 to PUT ${PROJECT}/merge_requests/4/merge: 401 Unauthorized`,
    });
    expect(rejected).not.toHaveBeenCalled();
    keyAccepted = false;
    await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
      failure: "sign-in",
    });
    expect(rejected).toHaveBeenCalledTimes(1);
    // The squash was asked for with the title alone when the description is empty.
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      sha: "a".repeat(40),
      squash: true,
      squash_commit_message: "fix: the meter",
    });
  });

  it("finds only a merge request from the project's own branch, never a fork's of the same name", async () => {
    const { forge } = forgeAnswering(() =>
      Response.json([request({ iid: 5, source_project_id: 99 }), request()]),
    );
    expect(await forge.changeFor("fm/task-1")).toMatchObject({ number: 4 });
  });
});
