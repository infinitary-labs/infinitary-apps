/**
 * A kept write passed by a yes that still stands (INF-6987's approved plan,
 * piece A1; docs/forge.md, "A write that asks"): a write an answer or
 * side-effect task keeps on its own project, or any write through the
 * github.com sign-in, goes once with no card on a yes of the captain's the
 * crewmate names as its allowance. An unsafe data reader's write and a
 * write to another project stay kept for the click whatever yes they name
 * (the captain's pick: reader route A).
 */
import type { ForgeWriteAsk } from "@shared/writeAsk";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fixture } from "../../../../../tests/helpers/githubGatewayHarness";
import { seedDelivery } from "../../../../../tests/helpers/taskDelivery";
import { KnowledgeService } from "../../../knowledge/knowledgeService";

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

const METER = { id: "repo-1", name: "meter", path: "/projects/meter" };

/** The example direction INF-6987's approved plan gives for an intake round's send tasks. */
const INTAKE_RULE =
  "Outside intake send tasks may post replies and approve runs that plainly follow docs/outside-intake.md, and nothing else; anything odd or ambiguous waits for my click.";

const REPLY = {
  method: "POST" as const,
  path: "/repos/octo/meter/issues/1/comments",
  body: '{"body":"Thanks for the report. We can reproduce the slow cold start, and a fix is in progress."}',
};

/** The sentence every kept-write answer ends with, as the crewmate reads it. */
const KEPT_WRITE_WAY =
  "Soft hold kept-write: it passes when the captain clicks the button that sends it, or github_write names as its allowance a yes that still stands and covers it: a project direction heard from the captain by its d: id, a card on the task's Already allowed list, or standing for the captain's standing override.";

async function gateway() {
  const knowledge = new KnowledgeService({
    projects: { get: (id) => (id === METER.id ? METER : undefined), list: () => [METER] },
  });
  const harness = await fixture({ directions: knowledge.directions });
  const asks = (taskId: string) =>
    (harness.tasks.get(taskId)?.delivery?.writeAsks ?? []) as ForgeWriteAsk[];
  const sent = () => harness.seen.map(({ method, path }) => `${method} ${path}`);
  return { ...harness, knowledge, asks, sent };
}

describe("a kept write passed by a yes that still stands", () => {
  it("sends a side-effect task's reply once on a heard direction, with no card, and keeps it taken naming the direction", async () => {
    const { knowledge, writeAs, service, tasks, asks, sent } = await gateway();
    knowledge.directions.change({
      op: "add",
      id: "intake-replies",
      scope: METER.id,
      text: INTAKE_RULE,
      reason: "The captain said so in their own words.",
      heard: { from: "turn" },
    });
    const answer = (
      await writeAs("task-side-effect").run({ ...REPLY, allowance: "d:intake-replies" })
    ).text;
    expect(answer).toContain(
      "Sent once on d:intake-replies, which still stands, with no card: kept on this task as ask",
    );
    expect(answer).toContain('"status": 201');
    expect(sent()).toEqual(["POST /repos/octo/meter/issues/1/comments"]);
    const [ask] = asks("task-side-effect");
    expect(ask).toMatchObject({
      yes: "d:intake-replies",
      method: "POST",
      path: REPLY.path,
      body: REPLY.body,
      sentAt: expect.any(Number),
      outcome: { kind: "answered", status: 201 },
    });
    const line = tasks.timeline("task-side-effect").find((event) => event.data?.said);
    expect(line?.text).toBe(
      "Sent POST /repos/octo/meter/issues/1/comments to GitHub once without a card, on your words “Outside intake send tasks may post replies and approve runs that plainly follow docs/outside-intake.md, and nothing…”: it answered 201.",
    );
    expect(line?.data?.said).toMatchObject({ m: "feedWriteSentOnWords" });

    expect(await service.sendAsk("task-side-effect", ask?.id ?? "")).toMatchObject({
      ok: false,
      outcome: { kind: "refused" },
    });
    expect(sent()).toHaveLength(1);
  });

  it("refuses a direction that was not heard from the captain, or was retired, keeping and sending nothing", async () => {
    const { knowledge, writeAs, asks, sent } = await gateway();
    knowledge.directions.change({
      op: "add",
      id: "own-reading",
      scope: METER.id,
      text: INTAKE_RULE,
      reason: "The first mate's reading of an earlier choice.",
    });
    knowledge.directions.change({
      op: "add",
      id: "old-replies",
      scope: METER.id,
      text: "Post plain replies on outside issues without asking.",
      reason: "The captain said so in their own words.",
      heard: { from: "turn" },
    });
    knowledge.directions.change({
      op: "retire",
      id: "d:old-replies",
      expectedRevision: 1,
      reason: "The captain no longer wants replies sent unseen.",
    });
    for (const allowance of ["d:own-reading", "d:old-replies"]) {
      const answer = (await writeAs("task-side-effect").run({ ...REPLY, allowance })).text;
      expect(answer).toContain(
        `Refused: nothing was kept or sent. ${allowance} is no yes that still stands on this task`,
      );
      expect(answer).toContain(KEPT_WRITE_WAY);
    }
    expect(asks("task-side-effect")).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it("sends on the captain's standing override while one stands, and refuses standing when none does", async () => {
    const { writeAs, tasks, sent } = await gateway();
    const tell = writeAs("task-side-effect");
    expect((await tell.run({ ...REPLY, allowance: "standing" })).text).toContain(
      "Refused: nothing was kept or sent. standing is no yes that still stands on this task",
    );
    expect(sent()).toEqual([]);
    seedDelivery(tasks, "task-side-effect", {
      override: {
        words: "Post the reply on the cold start issue without asking me again.",
        holds: ["asks-first"],
        until: "task",
        at: 1,
      },
    });
    expect((await tell.run({ ...REPLY, allowance: "standing" })).text).toContain(
      "Sent once on standing, which still stands, with no card",
    );
    expect(sent()).toEqual(["POST /repos/octo/meter/issues/1/comments"]);
  });

  it("sends a write through the github.com sign-in on an Already allowed card, and refuses the card once the captain takes it back", async () => {
    const { writeAs, tasks, sent } = await gateway();
    seedDelivery(tasks, "task-4", {
      captainAllowances: [
        {
          words: 'Post it, on the card "Post the reply on the meter issue?"',
          covers: "Posting the drafted reply on octo/meter issue #1",
          card: "card-reply",
          at: 1,
        },
      ],
    });
    const answer = writeAs("task-4");
    expect((await answer.run({ ...REPLY, allowance: "card-reply" })).text).toContain(
      "Sent once on card-reply, which still stands, with no card",
    );
    expect(sent()).toEqual(["POST /repos/octo/meter/issues/1/comments"]);
    tasks.delivery.withdrawAllowance("task-4", "card-reply");
    expect((await answer.run({ ...REPLY, allowance: "card-reply" })).text).toContain(
      "Refused: nothing was kept or sent. card-reply is no yes that still stands on this task",
    );
    expect(sent()).toHaveLength(1);
  });

  it("keeps a write that names no yes for the captain's click, saying which yes would pass it", async () => {
    const { writeAs, asks, sent } = await gateway();
    const answer = (await writeAs("task-side-effect").run(REPLY)).text;
    expect(answer).toContain(
      "Not sent: this task does an outside action, so every write it makes but a run start or rerun on its own project asks the captain",
    );
    expect(answer).toContain(KEPT_WRITE_WAY);
    expect(asks("task-side-effect")).toEqual([
      expect.not.objectContaining({ yes: expect.anything() }),
    ]);
    expect(sent()).toEqual([]);
  });

  it("keeps an unsafe data reader's write and a write to another project for the click, whatever yes they name", async () => {
    const { knowledge, writeAs, presentReaderAsk, asks, sent } = await gateway();
    knowledge.directions.change({
      op: "add",
      id: "intake-replies",
      scope: METER.id,
      text: INTAKE_RULE,
      reason: "The captain said so in their own words.",
      heard: { from: "turn" },
    });
    const allowance = "d:intake-replies";
    const passedNothing = `The allowance ${allowance} passed nothing: a named yes passes only a write this task would keep on its own project or through the github.com sign-in, never an unsafe data reader's write, one through an integration or one to another project.`;

    const reader = (await writeAs("task-reader").run({ ...REPLY, allowance })).text;
    expect(reader).toContain(
      "Not sent: this task reads words strangers can write, so every write it makes, run starts included, waits for the captain",
    );
    expect(reader).toContain(passedNothing);
    expect(presentReaderAsk).toHaveBeenCalledTimes(1);

    const elsewhere = {
      method: "POST" as const,
      path: "/repos/acme/site/issues/5/comments",
      body: '{"body":"The fix for this shipped in meter 1.4."}',
    };
    for (const taskId of ["task-1", "task-side-effect"]) {
      const answer = (await writeAs(taskId).run({ ...elsewhere, allowance })).text;
      expect(answer).toContain("Not sent:");
      expect(answer).toContain(passedNothing);
      expect(asks(taskId)).toHaveLength(1);
    }
    expect(sent()).toEqual([]);
  });

  it("never sends again a write sent on a yes whose outcome is unknown", async () => {
    const { knowledge, writeAs, service, asks, sent } = await gateway();
    knowledge.directions.change({
      op: "add",
      id: "intake-replies",
      scope: METER.id,
      text: INTAKE_RULE,
      reason: "The captain said so in their own words.",
      heard: { from: "turn" },
    });
    const answer = (
      await writeAs("task-side-effect").run({
        method: "POST",
        path: "/repos/octo/meter/issues/3/comments",
        body: '{"body":"Thanks, we can reproduce this on a fresh install."}',
        allowance: "d:intake-replies",
      })
    ).text;
    expect(answer).toContain("Sent once on d:intake-replies, but what came of it is unknown");
    expect(answer).toContain("This is the fixed limit sent-once: no one's word passes it.");
    const [ask] = asks("task-side-effect");
    expect(ask?.outcome).toMatchObject({ kind: "unknown" });
    expect(await service.sendAsk("task-side-effect", ask?.id ?? "")).toMatchObject({
      ok: false,
      outcome: { kind: "refused" },
    });
    expect(sent()).toEqual(["POST /repos/octo/meter/issues/3/comments"]);
  });
});
