/**
 * @journey-area src/core/queue/
 * Run the shipped merge job against the journey's private HTTP host.
 * CI's passed-status writer and GitHub's post-merge signal are stand-ins;
 * request, approval, permissions and squash reads/writes go through HTTP.
 */
import {
  mergePassed as githubMerge,
  type ScriptArgs,
} from "../../src/core/queue/shipped/github.mjs";
import {
  type GitLabQueueApi,
  mergePassed as gitlabMerge,
} from "../../src/core/queue/shipped/gitlab.mjs";
import { QUEUE } from "../../src/core/queue/shipped/rules.mjs";
import { GITHUB_STUB_KEY } from "./githubStub";
import { GITLAB_STUB_KEY } from "./gitlabStub";

export async function mergePassedFixture(input: {
  kind: "github" | "gitlab";
  url: string;
  project: string;
  base: string;
}) {
  const json = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${input.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.kind === "github" ? GITHUB_STUB_KEY : GITLAB_STUB_KEY}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`Queue fixture refused ${method} ${path}: ${response.status}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  };
  if (input.kind === "gitlab") {
    const user = await json<{ id: number }>("GET", "/user");
    const api: GitLabQueueApi = {
      get: (path) => json("GET", path),
      list: async (path) => {
        const rows = await json<Record<string, unknown>[]>("GET", path);
        return path.includes("/statuses?")
          ? rows.map((row) =>
              row.name === QUEUE && row.status === "success" ? { ...row, author: user } : row,
            )
          : rows;
      },
      send: (method, path, body) => json(method, path, body),
      text: async () => {
        throw new Error("A merge job never reads contributed source");
      },
    };
    await gitlabMerge({
      api,
      env: {
        project: input.project,
        defaultBranch: "main",
        pipelineId: 1,
        pipelineUrl: "https://gitlab.com/fixture/-/pipelines/1",
      },
      log: (text) => console.log(text),
    });
    return;
  }
  const root = `/repos/${input.project}`;
  const data = async (method: string, path: string, body?: unknown) => ({
    data: await json(method, path, body),
  });
  const github = {
    paginate: async (read: (args: unknown) => Promise<{ data: unknown }>, args: unknown) =>
      (await read(args)).data,
    rest: {
      pulls: {
        list: () => data("GET", `${root}/pulls?state=open&per_page=100`),
        get: ({ pull_number }: { pull_number: number }) =>
          data("GET", `${root}/pulls/${pull_number}`),
        merge: ({ pull_number, ...body }: { pull_number: number; [key: string]: unknown }) =>
          data("PUT", `${root}/pulls/${pull_number}/merge`, body),
      },
      issues: {
        listComments: ({ issue_number }: { issue_number: number }) =>
          data("GET", `${root}/issues/${issue_number}/comments?per_page=100`),
      },
      repos: {
        listCommitStatusesForRef: async ({ ref }: { ref: string }) => ({
          data: (
            await json<Record<string, unknown>[]>("GET", `${root}/commits/${ref}/statuses`)
          ).map((row) =>
            row.context === QUEUE && row.state === "success"
              ? { ...row, creator: { login: "github-actions[bot]" } }
              : row,
          ),
        }),
        getCollaboratorPermissionLevel: ({ username }: { username: string }) =>
          data("GET", `${root}/collaborators/${username}/permission`),
        getBranch: async () => ({ data: { commit: { sha: input.base } } }),
        createDispatchEvent: async () => ({ data: {} }),
        createCommitStatus: ({ sha, ...body }: { sha: string; [key: string]: unknown }) =>
          data("POST", `${root}/statuses/${sha}`, body),
      },
      actions: {
        createWorkflowDispatch: ({
          workflow_id,
          ...body
        }: {
          workflow_id: string;
          [key: string]: unknown;
        }) => data("POST", `${root}/actions/workflows/${workflow_id}/dispatches`, body),
      },
    },
  };
  const [owner, repo] = input.project.split("/");
  if (!owner || !repo) throw new Error("The queue fixture needs its project address");
  const context: ScriptArgs["context"] = {
    repo: { owner, repo },
    runId: 1,
    serverUrl: "https://github.com",
    payload: { repository: { default_branch: "main" } },
  };
  const core: ScriptArgs["core"] = {
    notice: (text) => console.log(text),
    setOutput: () => {},
    summary: {
      addHeading: () => {
        throw new Error("A merge job writes no checks summary");
      },
    },
  };
  await githubMerge({ github, context, core });
}
