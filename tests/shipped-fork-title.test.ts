import { describe, expect, it, vi } from "vitest";
import { mergePassed as githubMerge, type ScriptArgs } from "../src/core/queue/shipped/github.mjs";
import {
  type GitLabQueueApi,
  mergePassed as gitlabMerge,
  MAINTAINER,
} from "../src/core/queue/shipped/gitlab.mjs";
import {
  commitEnvelope,
  NAMING_DECISION,
  revocationEnvelope,
} from "../src/core/queue/shipped/message.mjs";
import { passed, QUEUE } from "../src/core/queue/shipped/rules.mjs";

// Accepted fork repair: exercise each shipped merge dispatcher, not merely the packet's text.
// The host readings use the existing meter contribution fixture; CI's passed verdict is a stand-in.
const head = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
const requestTitle = "Fix typo";
const title = "Review the meter";
const body = "Keep the meter reading.";
const approval = commitEnvelope(head, body, title, { naming: NAMING_DECISION.off, requestTitle });
const approved = `Approved for the batch queue at this version.\n\n<!-- infinitary-merge-approval -->\n${approval}`;
const createdAt = "2026-10-09T12:00:00Z";
type Case = "approved" | "renamed" | "revoked";

function notes(read: number, mode: Case) {
  return [
    {
      id: read > 1 && mode === "revoked" ? 73 : 72,
      body: read > 1 && mode === "revoked" ? revocationEnvelope(head) : approved,
    },
  ];
}

describe("the shipped queue's independent fork squash title", () => {
  it.each(["approved", "renamed", "revoked"] as const)(
    "GitHub dispatches only the captured approval: %s",
    async (mode) => {
      let reads = 0;
      const pull = {
        number: 23,
        state: "open",
        title: mode === "renamed" ? `${requestTitle} edited` : requestTitle,
        head: { sha: head, repo: { full_name: "contributor/meter" } },
        base: { ref: "main" },
        labels: [],
      };
      const merge = vi.fn(async () => ({ data: { merged: true } }));
      const statuses = vi.fn(async () => ({}));
      const github = {
        paginate: async (read: () => Promise<unknown[]>) => read(),
        rest: {
          pulls: { list: async () => [pull], get: async () => ({ data: pull }), merge },
          repos: {
            listCommitStatusesForRef: async () => [
              {
                context: QUEUE,
                state: "success",
                description: passed(72, head),
                target_url: "https://github.com/octo/meter/actions/runs/72",
                created_at: createdAt,
                creator: { login: "github-actions[bot]" },
              },
            ],
            getCollaboratorPermissionLevel: async () => ({ data: { permission: "maintain" } }),
            getBranch: async () => ({ data: { commit: { sha: head } } }),
            createDispatchEvent: async () => ({}),
            createCommitStatus: statuses,
          },
          issues: {
            listComments: async () =>
              notes(++reads, mode).map((note) => ({ ...note, user: { login: "maintainer" } })),
          },
          actions: { createWorkflowDispatch: async () => ({}) },
        },
      };
      const context: ScriptArgs["context"] = {
        repo: { owner: "octo", repo: "meter" },
        runId: 72,
        serverUrl: "https://github.com",
        payload: { repository: { default_branch: "main" } },
      };
      const core: ScriptArgs["core"] = {
        notice: vi.fn(),
        setOutput: vi.fn(),
        summary: {
          addHeading: () => {
            throw new Error("A merge writes no batch summary");
          },
        },
      };
      await githubMerge({ github, context, core });
      if (mode === "approved") {
        expect(merge).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            pull_number: pull.number,
            sha: head,
            commit_title: title,
            commit_message: body,
            merge_method: "squash",
          }),
        );
        expect(statuses).not.toHaveBeenCalled();
      } else expect(merge).not.toHaveBeenCalled();
      expect(pull.title).toBe(mode === "renamed" ? `${requestTitle} edited` : requestTitle);
    },
  );

  it.each(["approved", "renamed", "revoked"] as const)(
    "GitLab dispatches only the captured approval: %s",
    async (mode) => {
      let reads = 0;
      const request = {
        iid: 23,
        state: "opened",
        title: mode === "renamed" ? `${requestTitle} edited` : requestTitle,
        sha: head,
        target_branch: "main",
        source_project_id: 99,
        target_project_id: 77,
        labels: [],
      };
      const merge = vi.fn(async (_payload: unknown) => ({ state: "merged", sha: head }));
      const api: GitLabQueueApi = {
        get: async (path) => {
          if (path === "/user") return { id: 1 };
          if (path.endsWith("/members/all/1")) return { access_level: MAINTAINER };
          if (path === "/projects/77/merge_requests/23") return request;
          throw new Error(`Unexpected queue read: ${path}`);
        },
        list: async (path) => {
          if (path.includes("/statuses?"))
            return [
              {
                id: 73,
                name: QUEUE,
                status: "success",
                description: passed(72, head),
                target_url: "https://gitlab.com/octo/meter/-/pipelines/72",
                created_at: createdAt,
                author: { id: 1 },
              },
            ];
          if (path.includes("/notes?"))
            return notes(++reads, mode).map((note) => ({ ...note, author: { id: 1 } }));
          if (path.startsWith("/projects/77/merge_requests?")) return [request];
          throw new Error(`Unexpected queue list: ${path}`);
        },
        send: async (method, path, payload) => {
          if (method === "PUT" && path === "/projects/77/merge_requests/23/merge")
            return merge(payload);
          if (
            method === "POST" &&
            (path === "/projects/77/pipeline" || path.startsWith("/projects/77/statuses/"))
          )
            return {};
          throw new Error(`Unexpected queue write: ${method} ${path}`);
        },
        text: async () => {
          throw new Error("A merge reads no batch source");
        },
      };
      await gitlabMerge({
        api,
        env: {
          project: 77,
          defaultBranch: "main",
          pipelineId: 72,
          pipelineUrl: "https://gitlab.com/octo/meter/-/pipelines/72",
        },
        log: vi.fn(),
      });
      if (mode === "approved")
        expect(merge).toHaveBeenCalledExactlyOnceWith({
          sha: head,
          squash: true,
          squash_commit_message: `${title}\n\n${body}`,
        });
      else expect(merge).not.toHaveBeenCalled();
      expect(request.title).toBe(mode === "renamed" ? `${requestTitle} edited` : requestTitle);
    },
  );
});
