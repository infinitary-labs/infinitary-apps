import { fencedSpans } from "@shared/outsideData";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fixture, RUNS } from "../../../../../tests/helpers/githubGatewayHarness";
import { readerFenceLabel } from "../../../orchestrator/githubGateway";
import { GITHUB_READ_TOOL } from "../../../pi/forgeTools";
import { ANSWER_WHOLE_MAX_CHARACTERS } from "../../../session/answerFiles";
import { bindTool } from "../../../session/tools";

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

describe("the GitHub gateway for an unsafe data reader", () => {
  // INF-6427's piece 1: the mark on a reader's project reads names its host.
  it("names an unsafe data reader's fence after its project's host", () => {
    expect(readerFenceLabel("github")).toBe("github-data");
    expect(readerFenceLabel("gitlab")).toBe("gitlab-data");
    expect(readerFenceLabel("bitbucket")).toBe("bitbucket-data");
  });

  // INF-6358's piece 4: a task that reads words strangers can write reads only
  // its own project, gets every answer fenced, and keeps every write for the
  // captain's card, run starts included.
  it("keeps an unsafe data reader to its own project, fences each answer afresh, and keeps every write for its card", async () => {
    const { service, writeAs, seen, presentReaderAsk, tasks } = await fixture();
    const read = bindTool(GITHUB_READ_TOOL, {
      onGithubRead: (i) => service.readForCrew("task-reader", i),
    });
    const first = (await read.run({ path: "/repos/octo/meter/pulls" })).text;
    const second = (await read.run({ path: "/repos/octo/meter/pulls" })).text;
    const fenceOf = (text: string) => fencedSpans(text)[0];
    expect(fenceOf(first)).toMatchObject({ label: "github-data", closed: true });
    expect(fenceOf(first)?.words).toContain('"status": 200');
    expect(fenceOf(second)?.value).not.toBe(fenceOf(first)?.value);
    for (const path of ["/repos/acme/site/issues", "/search/issues?q=meter", "/user"]) {
      expect((await read.run({ path })).text).toContain(
        "Refused: an unsafe data reader reads only its own project",
      );
    }
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /repos/octo/meter/pulls",
      "GET /repos/octo/meter/pulls",
    ]);

    const reader = writeAs("task-reader");
    const start = {
      method: "POST" as const,
      path: "/repos/octo/meter/actions/workflows/verify.yml/dispatches",
      body: '{"ref":"main"}',
    };
    const comment = {
      method: "POST" as const,
      path: "/repos/octo/meter/issues/1/comments",
      body: '{"body":"Thanks, we can reproduce this."}',
    };
    for (const write of [start, comment]) {
      const kept = (await reader.run(write)).text;
      expect(kept).toContain(
        "Not sent: this task reads words strangers can write, so every write it makes, run starts included, waits for the captain",
      );
      expect(kept).toContain("Do not emit a card for it.");
    }
    expect(presentReaderAsk.mock.calls.map(([taskId, ask]) => [taskId, ask.path])).toEqual([
      ["task-reader", start.path],
      ["task-reader", comment.path],
    ]);
    for (const write of [
      { method: "POST" as const, path: "/repos/acme/site/issues", body: "{}" },
      { ...comment, validationEffect: "vr-1" },
      { method: "POST" as const, path: "/repos/octo/meter/releases/1/assets", file: "notes.txt" },
    ]) {
      expect((await reader.run(write)).text).toMatch(/Refused: an unsafe data reader/);
    }
    expect(seen).toHaveLength(2);
    expect(tasks.get("task-reader")?.delivery?.writeAsks).toHaveLength(2);

    // Not now sends nothing; Only this time sends the kept call once.
    const [startAsk, commentAsk] = presentReaderAsk.mock.calls.map(([, ask]) => ask.id as string);
    const take = (id: string) => tasks.delivery.takeWriteAsk("task-reader", id);
    const denied = await service.sendTaken("task-reader", take(startAsk ?? ""), "deny");
    expect(denied.outcome).toEqual({
      kind: "refused",
      why: "The captain chose Not now. Nothing was sent.",
    });
    const sent = await service.sendTaken("task-reader", take(commentAsk ?? ""), "once");
    expect(sent.ok).toBe(true);
    expect(fencedSpans(sent.answer ?? "")[0]).toMatchObject({ label: "github-data", closed: true });
    expect(seen.map(({ method, path }) => `${method} ${path}`).slice(2)).toEqual([
      `POST ${comment.path}`,
    ]);
  });

  // INF-6388's review: a reader has no shell and its fence refuses the
  // temporary folder, so an answer saved there as a file would never be read.
  it("serves an unsafe data reader's long listing as the largest page its model reads whole, and refuses one no page fits", async () => {
    const { service, seen } = await fixture();
    const read = bindTool(GITHUB_READ_TOOL, {
      onGithubRead: (i) => service.readForCrew("task-reader", i),
    });
    const paged = (await read.run({ path: "/repos/octo/meter/actions/runs?per_page=50" })).text;
    expect(paged.length).toBeLessThanOrEqual(ANSWER_WHOLE_MAX_CHARACTERS);
    const span = fencedSpans(paged)[0];
    expect(span).toMatchObject({ label: "github-data", closed: true });
    const answer = JSON.parse(span?.words ?? "");
    const served = answer.body.workflow_runs.length;
    expect(served).toBeGreaterThan(0);
    expect(answer.body.workflow_runs[0].id).toBe(RUNS[0]?.id);
    expect(answer.note).toMatch(
      /at per_page=50 exceeds the \d+ characters an unsafe data reader's answer carries whole/,
    );
    expect(seen.at(-1)?.path).toBe(`/repos/octo/meter/actions/runs?per_page=${served}`);

    const refused = (await read.run({ path: "/repos/octo/meter/actions/workflows/phone.yml/runs" }))
      .text;
    expect(refused).toContain("Its first item alone passes");
    expect(refused).toContain("Ask for less: a smaller per_page, one item by its number");
  });
});
