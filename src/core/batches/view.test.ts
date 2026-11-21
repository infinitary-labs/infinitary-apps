import { type BatchRecord, FINISHED_BATCH_KEPT_MS } from "@shared/batches";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { RepoView } from "@shared/repos";
import { describe, expect, it } from "vitest";
import { type BatchesViewSources, batchesView } from "./view";

// Intent: the captain's approved plan for the Batches panel: `batches.list` gives each project
// on batched pull requests its line, open batch, changes left out and the batches that ended
// in the last day, each task by its key, so the panel can show them in the focused project.

const NOW = 50_000_000;
const METER: RepoView = {
  id: "repo-meter",
  name: "meter",
  path: "/projects/meter",
  setupKind: "clone",
  kind: "project",
  origin: "https://github.com/acme/meter.git",
  host: { kind: "github", name: "github.com" },
  delivery: "queue-pr",
  autonomy: false,
  rigor: "standard",
  runsOn: AUTOMATIC_COMPUTER,
};
const TASKS: Record<string, { key: string; title: string }> = {
  "t-parser": { key: "MTR-12", title: "Read dates with a time zone" },
  "t-export": { key: "MTR-14", title: "Add a CSV export" },
  "t-legend": { key: "MTR-15", title: "Keep the legend inside the chart" },
};
const HEAD = "1111111111111111111111111111111111111111";

function sources(repos: RepoView[]): BatchesViewSources {
  return {
    repos,
    projectOf: () => "project-acme",
    place: () => "GitHub",
    reading: () => ({
      head: HEAD,
      at: NOW - 60_000,
      passed: 3,
      failed: 1,
      running: 0,
      failedNames: ["lint"],
    }),
    task: (taskId) => TASKS[taskId],
    now: NOW,
  };
}

const RECORD: BatchRecord = {
  line: [
    {
      taskId: "t-legend",
      branch: "inf/legend",
      head: "3333333333333333333333333333333333333333",
      title: "fix(chart): keep the legend inside the chart",
      body: "",
      at: NOW - 120_000,
      after: "t-export",
    },
  ],
  open: {
    branch: "infinitary-batch/7c41",
    base: "0000000000000000000000000000000000000000",
    head: HEAD,
    since: NOW - 3_000_000,
    number: 31,
    url: "https://github.com/acme/meter/pull/31",
    members: [
      {
        taskId: "t-parser",
        branch: "inf/parser",
        head: "4444444444444444444444444444444444444444",
        title: "fix(parser): read dates with a time zone",
        body: "",
        at: 1_000,
        commit: "5555555555555555555555555555555555555555",
      },
    ],
    hold: { reason: "checks", head: HEAD, checks: ["lint"], at: NOW - 240_000 },
    holds: 1,
  },
  receipts: [],
  leftOut: [{ taskId: "t-export", head: "6666", reason: "it no longer combines", at: NOW }],
  finished: [
    {
      number: 29,
      formed: NOW - FINISHED_BATCH_KEPT_MS - 9_000_000,
      ended: NOW - FINISHED_BATCH_KEPT_MS - 1,
      outcome: "merged",
      members: [{ taskId: "t-parser", title: "an old batch" }],
      holds: 0,
    },
    {
      number: 30,
      url: "https://github.com/acme/meter/pull/30",
      formed: NOW - 9_000_000,
      ended: NOW - 6_000_000,
      outcome: "merged",
      members: [{ taskId: "t-export", title: "feat(export): add a CSV export" }],
      holds: 2,
    },
  ],
};

describe("batches.list", () => {
  it("gives a batched project its line, open batch, left-out changes and last day, each task by its key", () => {
    const [repo] = batchesView(sources([{ ...METER, batch: RECORD }])).repos;
    expect(repo).toMatchObject({
      repoId: "repo-meter",
      name: "meter",
      projectId: "project-acme",
      place: "GitHub",
      line: [{ taskId: "t-legend", key: "MTR-15", afterKey: "MTR-14", fix: false }],
      open: {
        number: 31,
        members: [{ taskId: "t-parser", key: "MTR-12" }],
        hold: { reason: "checks", checks: ["lint"], at: NOW - 240_000, detail: null },
        queued: false,
        stale: false,
        checks: { passed: 3, failed: 1, failedNames: ["lint"] },
      },
      leftOut: [{ taskId: "t-export", key: "MTR-14", reason: "it no longer combines" }],
    });
    // The batch that ended more than a day ago is left out.
    expect(repo?.finished).toEqual([
      {
        number: 30,
        url: "https://github.com/acme/meter/pull/30",
        formed: NOW - 9_000_000,
        ended: NOW - 6_000_000,
        outcome: "merged",
        holds: 2,
        members: [{ taskId: "t-export", key: "MTR-14", title: "feat(export): add a CSV export" }],
      },
    ]);
  });

  it("lists a batched project with nothing yet, leaves out one delivered otherwise, and keeps one whose record still holds a batch", () => {
    const direct = { ...METER, id: "repo-site", name: "site", delivery: "direct-pr" as const };
    const ended = { ...direct, id: "repo-docs", name: "docs", batch: RECORD };
    const view = batchesView(sources([METER, direct, ended]));
    expect(view.repos.map((repo) => repo.name)).toEqual(["meter", "docs"]);
    expect(view.repos[0]).toMatchObject({ line: [], open: null, leftOut: [], finished: [] });
  });
});
