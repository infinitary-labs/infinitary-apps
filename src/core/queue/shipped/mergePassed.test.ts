import { describe, expect, it, vi } from "vitest";
import { mergePassed as githubMerge, type ScriptArgs } from "./github.mjs";
import { type GitLabQueueApi, mergePassed as gitlabMerge } from "./gitlab.mjs";
import {
  commitEnvelope,
  commitMessage,
  labelApproval,
  NAMING_DECISION,
  readCommitEnvelope,
  revocationEnvelope,
} from "./message.mjs";
import { passed, QUEUE, WAITING } from "./rules.mjs";

// Accepted contributor-queue plan, piece B: a passed version merges without an
// app, preserving its summary, and batch checks never own the merge credential.
// In-memory REST stand-ins model the documented merge/status response shapes;
// no external account, clock, filesystem or runner is involved.
const head = "c40687d8d4f738056e62db6ab98b90f7f7d17497";
const tree = "be6452e81a110b0c50d7354add8d59a231807cce";
const title = "fix(queue): preserve the approved version";
const summary = "The queue merges the approved version.\nIt retains the summary.";
const description = `${commitEnvelope(head, summary, title, { naming: NAMING_DECISION.off })}\nThe published story.`;
const at = "2026-11-06T17:00:00Z";
const queueUser = { id: 9 };
const base = "9f2c4e1d0b8a7c6e5f4d3c2b1a0918273645abcd";

type GitHubComment = { id: number; body: string; user: { login: string }; html_url?: string };
const approvalBody = (atHead = head, words = summary, approvedTitle = title) =>
  `<!-- infinitary-merge-approval -->\n${commitEnvelope(atHead, words, approvedTitle, { naming: NAMING_DECISION.checked })}`;

function github() {
  const pull = {
    number: 61,
    state: "open",
    merged: false,
    head: { sha: head },
    base: { ref: "main" },
    title,
    body: description,
  };
  const comments = new Map<number, GitHubComment[]>([
    [pull.number, [{ id: 701, body: approvalBody(), user: { login: "maintainer" } }]],
  ]);
  const statuses = [
    {
      state: "success",
      creator: { login: "github-actions[bot]" },
      context: QUEUE,
      description: passed(503, tree),
      target_url: "",
      created_at: at,
    },
  ];
  const statusWrites: { sha: string; state: string; description: string }[] = [];
  const statusesByHead = new Map([[head, statuses]]);
  const merges: unknown[] = [];
  const signals: unknown[] = [];
  const starts: unknown[] = [];
  const rest = {
    pulls: {
      list: vi.fn(async () => (pull.state === "open" ? [pull] : [])),
      get: vi.fn(async (_input: unknown) => ({ data: pull })),
      merge: vi.fn(async (args: unknown) => {
        merges.push(args);
        pull.state = "closed";
        return { data: { merged: true } };
      }),
    },
    issues: {
      listComments: vi.fn(
        async ({ issue_number }: { issue_number: number }) => comments.get(issue_number) ?? [],
      ),
    },
    repos: {
      getCollaboratorPermissionLevel: async ({ username }: { username: string }) => ({
        data: { permission: username === "maintainer" ? "write" : "read" },
      }),
      getBranch: async () => ({ data: { commit: { sha: base } } }),
      createCommitStatus: async (write: { sha: string; state: string; description: string }) => {
        statusWrites.push(write);
        const rows = statusesByHead.get(write.sha) ?? statuses.map((status) => ({ ...status }));
        rows.unshift({ ...statuses[0]!, ...write, creator: { login: "github-actions[bot]" } });
        statusesByHead.set(write.sha, rows);
      },
      listCommitStatusesForRef: vi.fn(async (input: { ref: string }) => {
        if (!statusesByHead.has(input.ref))
          statusesByHead.set(
            input.ref,
            statuses.map((status) => ({ ...status })),
          );
        return statusesByHead.get(input.ref)!;
      }),
      createDispatchEvent: vi.fn(async (args: unknown) => {
        signals.push(args);
      }),
    },
    actions: {
      createWorkflowDispatch: vi.fn(async (args: unknown) => {
        starts.push(args);
      }),
    },
  };
  const args: ScriptArgs = {
    github: { rest, paginate: (fn: (args: unknown) => unknown, input: unknown) => fn(input) },
    context: {
      repo: { owner: "acme", repo: "shop" },
      runId: 503,
      serverUrl: "https://github.com",
      payload: { repository: { default_branch: "main" } },
    },
    core: {
      notice: vi.fn(),
      setOutput: vi.fn(),
      summary: { addHeading: () => ({ addRaw: () => ({ write: async () => undefined }) }) },
    },
  };
  return { args, pull, statuses, rest, merges, signals, starts, statusWrites, comments };
}

describe("queue-owned GitHub merges", () => {
  it("squashes the passed head, signals once and starts the next batch without an app", async () => {
    const p = github();
    await githubMerge(p.args);
    expect(p.merges).toEqual([
      {
        owner: "acme",
        repo: "shop",
        pull_number: p.pull.number,
        sha: head,
        merge_method: "squash",
        commit_title: title,
        commit_message: summary,
        request: { retries: 0 },
      },
    ]);
    expect(p.signals).toEqual([
      {
        owner: "acme",
        repo: "shop",
        event_type: "infinitary-after-merge",
        client_payload: { base },
      },
    ]);
    expect(p.starts).toEqual([
      {
        owner: "acme",
        repo: "shop",
        workflow_id: "infinitary-queue.yml",
        ref: "main",
        inputs: { action: "form" },
      },
    ]);
    await githubMerge(p.args);
    expect(p.merges).toHaveLength(1);
    expect(p.signals).toHaveLength(1);
  });

  it("uses a write-authorized review comment on a fork without changing its description", async () => {
    const p = github();
    Object.assign(p.pull.head, { repo: { full_name: "contributor/shop" } });
    Object.assign(p.pull.base, { repo: { full_name: "acme/shop" } });
    p.pull.body = "The contributor's description.";
    const review = approvalBody();
    Object.assign(p.rest, {
      issues: {
        listComments: async () => [
          { id: 701, body: review, user: { login: "maintainer" } },
          { id: 702, body: review, user: { login: "visitor" } },
        ],
      },
    });
    Object.assign(p.rest.repos, {
      getCollaboratorPermissionLevel: async ({ username }: { username: string }) => ({
        data: { permission: username === "maintainer" ? "write" : "read" },
      }),
    });
    await githubMerge(p.args);
    expect(p.merges).toMatchObject([{ commit_message: summary }]);
    expect(p.pull.body).toBe("The contributor's description.");
  });

  // INF-3542's plan, piece C: the queue label's job records the labelled
  // version's approval with the workflow's own key, and the merge job
  // trusts what that key wrote, as it trusts the passes it writes.
  it("merges a version the queue label approved, with the description as its words, and trusts no one else's copy", async () => {
    const p = github();
    p.pull.body = "The contributor's description.";
    const record = labelApproval(head, p.pull.body, title);
    Object.assign(p.rest, {
      issues: {
        listComments: async () => [
          { id: 801, body: record, user: { login: "visitor" } },
          { id: 802, body: record, user: { login: "github-actions[bot]" } },
        ],
      },
    });
    await githubMerge(p.args);
    expect(p.merges).toEqual([
      expect.objectContaining({ commit_message: "The contributor's description." }),
    ]);

    const forged = github();
    Object.assign(forged.rest, {
      issues: {
        listComments: async () => [{ id: 803, body: record, user: { login: "visitor" } }],
      },
    });
    await githubMerge(forged.args);
    expect(forged.merges).toEqual([]);
  });

  it("ignores a fork author's forged approval envelope without a trusted review", async () => {
    const p = github();
    Object.assign(p.pull.head, { repo: { full_name: "contributor/shop" } });
    Object.assign(p.pull.base, { repo: { full_name: "acme/shop" } });
    p.pull.title = "Author supplied free-form title";
    p.pull.body = commitEnvelope(head, summary, p.pull.title, {
      naming: NAMING_DECISION.off,
    });
    p.comments.set(p.pull.number, []);
    await githubMerge(p.args);
    expect(p.merges).toEqual([]);
    expect(p.statusWrites.at(-1)?.description).toContain("trusted approval");
  });

  it("takes the active naming result and exact words from the newest trusted record, not the status link", async () => {
    const p = github();
    p.pull.title = "Release this approved change";
    const url = "https://github.com/acme/shop/pull/61#issuecomment-701";
    p.statuses.push({
      ...p.statuses[0]!,
      state: "pending",
      description: WAITING,
      target_url: url,
      creator: { login: "maintainer" },
    });
    p.statuses.push({ ...p.statuses[1]!, target_url: url + "2" });
    const approved = `<!-- infinitary-merge-approval -->\n${commitEnvelope(head, summary, p.pull.title, { naming: NAMING_DECISION.checked })}`;
    Object.assign(p.rest.issues, {
      listComments: async () => [
        { id: 701, html_url: url, body: approved, user: { login: "maintainer" } },
        {
          id: 700,
          html_url: url + "2",
          body: `<!-- infinitary-merge-approval -->\n${commitEnvelope(head, "Older words", title, { naming: NAMING_DECISION.checked })}`,
          user: { login: "maintainer" },
        },
        {
          id: 703,
          html_url: url + "3",
          body: "<!-- infinitary-story:obsolete:start -->\n<!-- infinitary-squash:ff -->",
          user: { login: "maintainer" },
        },
      ],
    });
    Object.assign(p.rest.repos, {
      getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }),
    });
    await githubMerge(p.args);
    expect(p.merges).toMatchObject([{ commit_title: p.pull.title, commit_message: summary }]);
  });

  it("marks an earlier refused change failed and still merges a later passed change", async () => {
    const p = github();
    const later = {
      ...p.pull,
      number: p.pull.number + 1,
      head: { sha: tree },
      body: commitEnvelope(tree, summary, title, { naming: NAMING_DECISION.off }),
    };
    p.comments.set(later.number, [
      { id: 801, body: approvalBody(later.head.sha), user: { login: "maintainer" } },
    ]);
    p.rest.pulls.list.mockResolvedValueOnce([p.pull, later]);
    p.rest.pulls.get.mockImplementation(async (input) => ({
      data: (input as { pull_number: number }).pull_number === p.pull.number ? p.pull : later,
    }));
    p.rest.pulls.merge.mockRejectedValueOnce(new Error("Required review missing"));
    await githubMerge(p.args);
    expect(p.statusWrites).toMatchObject([
      {
        sha: head,
        state: "failure",
        description: expect.stringContaining("Required review missing"),
      },
    ]);
    expect(p.merges).toMatchObject([{ pull_number: later.number }]);
    expect(p.signals).toHaveLength(1);
    expect(p.starts).toHaveLength(1);
  });

  // Reviewer F1: status-write access is not the queue job's merge authority.
  it("refuses another integration's forged pass and a forged replacement after selection", async () => {
    for (const afterSelection of [false, true]) {
      const p = github();
      const forged = [{ ...p.statuses[0]!, creator: { login: "another-integration[bot]" } }];
      if (afterSelection)
        p.rest.repos.listCommitStatusesForRef
          .mockResolvedValueOnce(p.statuses)
          .mockResolvedValueOnce(forged);
      else p.statuses[0]!.creator = forged[0]!.creator;
      await githubMerge(p.args);
      expect(p.merges).toEqual([]);
      expect(p.statusWrites.at(-1)).toMatchObject({ sha: head, state: "failure" });
      expect(p.statuses[0]?.state).toBe("failure");
    }
  });

  // Reviewer F5: title edits after approval cannot change the squash's release type.
  it("refuses a title edited after its head-bound story was approved", async () => {
    const p = github();
    p.pull.title = "feat(queue): change the release type";
    await githubMerge(p.args);
    expect(p.statusWrites.at(-1)?.description).toContain("title changed");
    expect(p.merges).toEqual([]);
  });

  it("does not merge a new head discovered after selecting the passed version", async () => {
    const p = github();
    p.rest.pulls.get.mockImplementation(async () => ({ data: { ...p.pull, head: { sha: tree } } }));
    await githubMerge(p.args);
    expect(p.merges).toEqual([]);
    expect(p.signals).toEqual([]);
  });

  it("rechecks the pass marker and refuses a withdrawn pass", async () => {
    const p = github();
    p.rest.repos.listCommitStatusesForRef
      .mockResolvedValueOnce(p.statuses)
      .mockResolvedValueOnce([{ ...p.statuses[0]!, state: "pending", description: WAITING }]);
    await githubMerge(p.args);
    expect(p.merges).toEqual([]);
  });

  it("never retries a refused merge or claims its signal", async () => {
    const p = github();
    p.rest.pulls.merge.mockRejectedValueOnce(new Error("Branch rules refuse this merge"));
    await githubMerge(p.args);
    expect(p.statusWrites.at(-1)?.description).toContain("Branch rules");
    expect(p.starts).toHaveLength(1);
    expect(p.rest.pulls.merge).toHaveBeenCalledTimes(1);
    expect(p.signals).toEqual([]);
  });

  it("reads a lost merge response back once instead of replaying it", async () => {
    const p = github();
    p.rest.pulls.merge.mockImplementationOnce(async () => {
      p.pull.state = "closed";
      p.pull.merged = true;
      throw new Error("The merge response was lost");
    });
    await githubMerge(p.args);
    expect(p.rest.pulls.merge).toHaveBeenCalledTimes(1);
    expect(p.signals).toHaveLength(1);
    expect(p.starts).toHaveLength(1);
  });

  it("signals earlier merges even when a later change is refused", async () => {
    const p = github();
    const later = {
      ...p.pull,
      number: p.pull.number + 1,
      head: { sha: tree },
      body: commitEnvelope(tree, summary, title, { naming: NAMING_DECISION.off }),
    };
    p.comments.set(later.number, [
      { id: 801, body: approvalBody(later.head.sha), user: { login: "maintainer" } },
    ]);
    p.rest.pulls.list.mockResolvedValueOnce([later, p.pull]);
    p.rest.pulls.get.mockImplementation(async (input: unknown) => ({
      data: (input as { pull_number: number }).pull_number === p.pull.number ? p.pull : later,
    }));
    p.rest.pulls.merge
      .mockResolvedValueOnce({ data: { merged: true } })
      .mockRejectedValueOnce(new Error("Later merge refused"));
    await githubMerge(p.args);
    expect(p.statusWrites.at(-1)).toMatchObject({ sha: tree, state: "failure" });
    expect(
      p.rest.pulls.merge.mock.calls.map(
        ([input]) => (input as { pull_number: number }).pull_number,
      ),
    ).toEqual([p.pull.number, later.number]);
    expect(p.signals).toHaveLength(1);
    expect(p.starts).toHaveLength(1);
  });

  it("still starts the next batch if the after-merge signal fails", async () => {
    const p = github();
    p.rest.repos.createDispatchEvent.mockRejectedValueOnce(new Error("Signal refused"));
    await expect(githubMerge(p.args)).rejects.toThrow("Signal refused");
    expect(p.merges).toHaveLength(1);
    expect(p.starts).toHaveLength(1);
  });
});

function gitlab() {
  const request = {
    iid: 61,
    state: "opened",
    sha: head,
    target_branch: "main",
    title,
    description,
    web_url: "https://gitlab.example.com/acme/shop/-/merge_requests/61",
  };
  const notes = [{ id: 701, body: approvalBody(), author: { id: 7 } }];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const statuses = [
    {
      id: 90,
      author: queueUser,
      name: QUEUE,
      status: "success",
      description: passed(503, tree),
      created_at: at,
      target_url: "",
    },
  ];
  const api: GitLabQueueApi = {
    get: async (path) =>
      path === "/user"
        ? queueUser
        : path.includes("/members/all/")
          ? { access_level: path.endsWith("/7") ? 40 : 30 }
          : request,
    text: async () => "",
    list: async (path) =>
      path.includes("/statuses?")
        ? statuses
        : path.includes("/notes?")
          ? notes
          : request.state === "opened"
            ? [request]
            : [],
    send: async (method, path, body) => {
      writes.push({ method, path, body });
      if (path.includes("/statuses/")) {
        const write = body as { state: string; description: string };
        statuses.unshift({
          ...statuses[0]!,
          id: statuses[0]!.id + 1,
          status: write.state,
          description: write.description,
          author: queueUser,
        });
      }
      if (path.endsWith("/merge")) {
        request.state = "merged";
        return request;
      }
      return { id: 504 };
    },
  };
  const args = {
    api,
    env: {
      project: 42,
      defaultBranch: "main",
      pipelineId: 503,
      pipelineUrl: "https://gitlab.example.com/acme/shop/-/pipelines/503",
    },
    log: vi.fn(),
  };
  return { args, writes, request, statuses, notes };
}

describe("queue-owned GitLab merges", () => {
  it("uses the existing queue API, pins the head and starts only the next queue pipeline", async () => {
    const p = gitlab();
    await gitlabMerge(p.args);
    expect(p.writes).toEqual([
      {
        method: "PUT",
        path: `/projects/42/merge_requests/${p.request.iid}/merge`,
        body: { sha: head, squash: true, squash_commit_message: `${title}\n\n${summary}` },
      },
      { method: "POST", path: "/projects/42/pipeline", body: { ref: "main" } },
    ]);
    await gitlabMerge(p.args);
    expect(p.writes).toHaveLength(2);
  });

  it("uses the write-authorized review note for a fork and leaves its description alone", async () => {
    const p = gitlab();
    Object.assign(p.request, { source_project_id: 1, target_project_id: p.args.env.project });
    p.request.description = "The contributor's description.";
    const review = approvalBody();
    const list = p.args.api.list;
    p.args.api.list = async (path) =>
      path.includes("/notes?")
        ? [
            { id: 701, body: review, author: { id: 7 } },
            { id: 702, body: review, author: { id: 8 } },
          ]
        : list(path);
    const get = p.args.api.get;
    p.args.api.get = async (path) =>
      path.includes("/members/all/") ? { access_level: path.endsWith("/7") ? 40 : 20 } : get(path);
    await gitlabMerge(p.args);
    expect(p.writes[0]?.body).toMatchObject({ squash_commit_message: `${title}\n\n${summary}` });
    expect(p.request.description).toBe("The contributor's description.");
  });

  // F4 regression: a current approval supersedes older waiting marks and malformed obsolete stories.
  it("uses GitLab's newest approval mark even when older review words are malformed", async () => {
    const p = gitlab();
    const url = `${p.request.web_url}#note_701`;
    const approved = `<!-- infinitary-merge-approval -->\n${commitEnvelope(head, summary, title, { naming: NAMING_DECISION.checked })}`;
    p.statuses.push(
      {
        ...p.statuses[0]!,
        id: p.statuses[0]!.id - 1,
        author: { id: 7 },
        status: "skipped",
        description: WAITING,
        target_url: url,
      },
      {
        ...p.statuses[0]!,
        id: p.statuses[0]!.id - 2,
        author: { id: 7 },
        status: "skipped",
        description: WAITING,
        target_url: `${p.request.web_url}#note_702`,
      },
    );
    const list = p.args.api.list;
    p.args.api.list = async (path) =>
      path.includes("/notes?")
        ? [
            { id: 701, body: approved, author: { id: 7 } },
            {
              id: 700,
              body: `<!-- infinitary-merge-approval -->\n${commitEnvelope(head, "Older words", "An older title", { naming: NAMING_DECISION.off })}`,
              author: { id: 7 },
            },
            {
              id: 703,
              body: "<!-- infinitary-story:obsolete:start -->\n<!-- infinitary-squash:ff -->",
              author: { id: 7 },
            },
          ]
        : list(path);
    const get = p.args.api.get;
    p.args.api.get = async (path) =>
      path.includes("/members/all/") ? { access_level: 40 } : get(path);
    await gitlabMerge(p.args);
    expect(p.writes[0]).toMatchObject({
      method: "PUT",
      body: { squash_commit_message: `${title}\n\n${summary}` },
    });
  });

  it("marks a locked GitLab request failed rather than leaving it passed", async () => {
    const p = gitlab();
    const get = p.args.api.get;
    p.args.api.get = async (path) =>
      path === "/user" ? get(path) : { ...p.request, state: "locked" };
    await gitlabMerge(p.args);
    expect(p.writes[0]?.body).toMatchObject({
      state: "failed",
      description: expect.stringContaining("locked"),
    });
    expect(p.writes.at(-1)?.path).toBe("/projects/42/pipeline");
  });

  it("makes a replaced queue key's rejected old pass visible to the app", async () => {
    const p = gitlab();
    const get = p.args.api.get;
    p.args.api.get = async (path) => (path === "/user" ? { id: queueUser.id + 1 } : get(path));
    await gitlabMerge(p.args);
    expect(p.writes[0]?.body).toMatchObject({ state: "failed" });
    expect(p.statuses[0]?.status).toBe("failed");
    expect(p.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  });

  it("ignores a fork author's naming-off envelope without a trusted note", async () => {
    const p = gitlab();
    Object.assign(p.request, { source_project_id: 1, target_project_id: p.args.env.project });
    p.request.title = "Author supplied title";
    p.request.description = commitEnvelope(head, summary, p.request.title, {
      naming: NAMING_DECISION.off,
    });
    p.notes.length = 0;
    await gitlabMerge(p.args);
    expect(p.writes[0]?.body).toMatchObject({
      state: "failed",
      description: expect.stringContaining("trusted approval"),
    });
  });

  // Reviewer F1: the identity is the project token's user, never the approver's role.
  it("refuses a Developer's forged pass and an unreadable queue identity", async () => {
    for (const author of [8, undefined]) {
      const p = gitlab();
      const list = p.args.api.list;
      p.args.api.list = async (path) =>
        path.includes("/statuses?")
          ? (await list(path)).map((status) => ({
              ...status,
              author: author === undefined ? undefined : { id: author },
            }))
          : list(path);
      await gitlabMerge(p.args);
      expect(p.writes).toMatchObject([{ method: "POST", body: { state: "failed" } }]);
    }
    const p = gitlab();
    const get = p.args.api.get;
    p.args.api.get = async (path) => {
      if (path === "/user") throw new Error("Identity unavailable");
      return get(path);
    };
    await gitlabMerge(p.args);
    expect(p.writes).toMatchObject([{ method: "POST", body: { state: "failed" } }]);
  });

  it("refuses a changed approved title before a GitLab squash", async () => {
    const p = gitlab();
    p.request.title = "feat(queue): change the release type";
    await gitlabMerge(p.args);
    expect(p.writes[0]?.body).toMatchObject({
      state: "failed",
      description: expect.stringContaining("title changed"),
    });
    expect(p.writes.at(-1)?.path).toBe("/projects/42/pipeline");
  });

  it("does not merge another head or a different target", async () => {
    for (const changed of [{ sha: tree }, { target_branch: "release" }]) {
      const p = gitlab();
      const get = p.args.api.get;
      p.args.api.get = async (path) =>
        path === "/user" ? get(path) : { ...p.request, ...changed };
      await gitlabMerge(p.args);
      expect(p.writes).toEqual([
        { method: "POST", path: "/projects/42/pipeline", body: { ref: "main" } },
      ]);
    }
  });
});

describe("the squash message contract", () => {
  it("retains the exact typed summary and breaking footer instead of the evidence", () => {
    const story = {
      whatChanged: [summary],
      projectText: "BREAKING CHANGE: The queue owns merges.\nKeep the branch rules.",
    };
    const body = commitMessage(story);
    const approved = commitEnvelope(head, body, title, { naming: NAMING_DECISION.checked });
    expect(readCommitEnvelope(approved, head, title)).toBe(body);
    expect(() => readCommitEnvelope(approved, tree, title)).toThrow("version");
    expect(body).toBe(`${summary}\n\n${story.projectText}`);
  });

  it("uses the approved active naming runbook or its explicit off state, never a built-in pattern", () => {
    const title = "Release the finished queue";
    const configured = commitEnvelope(head, summary, title, {
      naming: NAMING_DECISION.checked,
    });
    expect(readCommitEnvelope(configured, head, title)).toBe(summary);
    const off = commitEnvelope(head, summary, title, {
      naming: NAMING_DECISION.off,
    });
    expect(readCommitEnvelope(off, head, title)).toBe(summary);
    // A public packet contains the naming result, not extra private configuration from its caller.
    const internal = {
      naming: NAMING_DECISION.checked,
      pattern: "^Private project .+$",
    };
    expect(commitEnvelope(head, summary, title, internal)).toBe(configured);
    expect(() =>
      Reflect.apply(commitEnvelope, undefined, [
        head,
        summary,
        title,
        { naming: { pattern: internal.pattern } },
      ]),
    ).toThrow("naming result");
    const nonliteral = `<!-- infinitary-squash:${Buffer.from(JSON.stringify({ head, body: summary, title, naming: NAMING_DECISION.checked, literal: false })).toString("hex")} -->`;
    expect(() => readCommitEnvelope(nonliteral, head, title)).toThrow(
      "literal approved merge words",
    );
    const unsupported = `<!-- infinitary-squash:${Buffer.from(JSON.stringify({ head, body: summary, title, naming: { pattern: "^Ship .+$" } })).toString("hex")} -->`;
    expect(() => readCommitEnvelope(unsupported, head, title)).toThrow("approved naming policy");
    expect(() => readCommitEnvelope("A plain description.", head, title)).toThrow(
      "approved naming policy",
    );
  });

  it("rejects generated story envelopes and plain descriptions as approval data", () => {
    const body =
      "<!-- infinitary-story:sample:start -->\n\n## Why\n\nKeep approval.\n\n## What changed\n\n- Preserve the approved version\\.\n- Keep checks read\\-only\\.\n\n## Before and after\n\nEvidence stays here.\n<!-- infinitary-story:sample:end -->\n\nBREAKING CHANGE: Merges no longer need an app.";
    expect(() => readCommitEnvelope(body, head, title)).toThrow("approved naming policy");
    expect(() => readCommitEnvelope("A contributor's description.", head, title)).toThrow(
      "approved naming policy",
    );
  });
});

// F3/R1: mutable status writers cannot revive a trusted revocation or supply approval data.
describe("trusted per-head revocation", () => {
  it("refuses a status-only replay, ignores records for other heads and accepts fresh trusted reapproval on GitHub", async () => {
    const p = github();
    const records = p.comments.get(p.pull.number)!;
    records.push({ id: 702, body: revocationEnvelope(head), user: { login: "maintainer" } });
    // An integration may nominate it again and the honest queue may pass its checks; neither revokes the record.
    p.statuses.push({
      ...p.statuses[0]!,
      state: "error",
      description: "Not queued: merge approval held or withdrawn",
    });
    records.push({ id: 703, body: approvalBody(tree), user: { login: "maintainer" } });
    await githubMerge(p.args);
    expect(p.merges).toEqual([]);
    expect(p.statusWrites.at(-1)?.description).toContain("withdrawn");
    records.push({ id: 704, body: approvalBody(), user: { login: "maintainer" } });
    records.push({ id: 705, body: revocationEnvelope(head), user: { login: "former-maintainer" } });
    const permission = p.rest.repos.getCollaboratorPermissionLevel;
    p.rest.repos.getCollaboratorPermissionLevel = async (input) => {
      if (input.username === "former-maintainer")
        throw Object.assign(new Error("No such member"), { status: 404 });
      return permission(input);
    };
    p.statuses.unshift({
      ...p.statuses[0]!,
      state: "success",
      description: passed(504, tree),
      creator: { login: "github-actions[bot]" },
    });
    await githubMerge(p.args);
    expect(p.merges).toHaveLength(1);
  });

  it("re-reads the trusted record immediately before the GitHub merge", async () => {
    const p = github();
    const records = p.comments.get(p.pull.number)!;
    p.rest.issues.listComments
      .mockResolvedValueOnce([...records])
      .mockResolvedValueOnce([
        ...records,
        { id: 702, body: revocationEnvelope(head), user: { login: "maintainer" } },
      ]);
    await githubMerge(p.args);
    expect(p.merges).toEqual([]);
  });

  it("refuses same-project description data without a trusted approval on either host", async () => {
    const gh = github();
    gh.comments.clear();
    await githubMerge(gh.args);
    expect(gh.merges).toEqual([]);
    const gl = gitlab();
    gl.notes.length = 0;
    await gitlabMerge(gl.args);
    expect(gl.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  });

  it("refuses Developer notes after revocation, then accepts a fresh Maintainer approval on GitLab", async () => {
    const p = gitlab();
    p.notes.push(
      { id: 702, body: revocationEnvelope(head), author: { id: 7 } },
      { id: 703, body: approvalBody(), author: { id: 8 } },
    );
    await gitlabMerge(p.args);
    expect(p.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
    p.notes.push({ id: 704, body: approvalBody(), author: { id: 7 } });
    p.statuses.unshift({
      ...p.statuses[0]!,
      id: p.statuses[0]!.id + 1,
      status: "success",
      description: passed(504, tree),
    });
    await gitlabMerge(p.args);
    expect(p.writes.filter((write) => write.path.endsWith("/merge"))).toHaveLength(1);
  });

  it("re-reads the trusted record immediately before the GitLab merge", async () => {
    const p = gitlab();
    const list = p.args.api.list;
    let reads = 0;
    p.args.api.list = async (path) => {
      if (path.includes("/notes?") && ++reads === 2)
        p.notes.push({ id: 702, body: revocationEnvelope(head), author: { id: 7 } });
      return list(path);
    };
    await gitlabMerge(p.args);
    expect(p.writes.some((write) => write.path.endsWith("/merge"))).toBe(false);
  });
});
