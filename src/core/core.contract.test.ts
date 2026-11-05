import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import type { FeedLine } from "@shared/feed";
import { PROTOCOL_VERSION, VIEW_FLOOR } from "@shared/ipc";
import { type TaskKind, taskKindSchema } from "@shared/tasks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AT_FIRST_LAUNCH,
  fakeHost,
  quotaFixture,
  serveConnection,
  waitFor,
} from "../../tests/helpers/bootedCore";
import { claimedPort } from "../../tests/helpers/claimedPort";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { type ScriptedClient, startScriptedClient } from "../../tests/helpers/scriptedClient";
import { startConnection } from "./connection/connection";
import { claimLink } from "./devices/dial";
import { type Core, startCore } from "./index";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { openDatabase } from "./storage/db";
import { seedTask } from "./tasks/seedTask";
import { TaskService } from "./tasks/taskService";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * A client that knows only the published contract, against the whole core
 * served over its connection (tests/helpers/bootedCore.ts).
 */

/**
 * The published contract from outside (docs/contract.md): a client that knows
 * the home only through docs/contract.json, run as its own plain-Node process
 * against the real core and the real connection. Each case answers the stall
 * card of its own stuck task, raised at boot.
 */
describe("a client that knows only the published contract", () => {
  let userDataDir: string;
  let _quotaDir: string;
  let core: Core;
  let connection: ReturnType<typeof startConnection>;
  let at: string;
  const stuck = [
    "contract-current",
    "contract-newer",
    "contract-behind",
    "contract-outside",
  ] as const;
  const major = Number(PROTOCOL_VERSION.split(".")[0]);

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-contract-");
    _quotaDir = quotaFixture("infinitary-core-contract-quota-");
    process.env.PI_OFFLINE = "1";
    // Crewmates idle for an hour and a half, nudged and woken twice: each
    // gets its stall card at boot.
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db });
    const now = Date.now();
    for (const id of stuck) {
      const worktreeDir = join(userDataDir, "worktrees", id);
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, { id, title: `Tidy ${id}`, status: "completed", worktreeDir });
      tasks.turns.recordRecovery(id, {
        rung: 2,
        count: 2,
        at: now - 35 * 60_000,
        idleSince: now - 90 * 60_000,
      });
    }
    db.close();
    core = await startCore(fakeHost(userDataDir).host);
    ({ connection, at } = await serveConnection(core));
    const booted = core;
    await waitFor(
      () =>
        stuck.every((id) =>
          booted.services.supervisor.cardsSnapshot().some((card) => card.id === `card-stall-${id}`),
        ),
      10_000,
    );
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    core?.dispose();
    await catalogRefreshesSettled();
    delete process.env.INFINITARY_QUOTA_FIXTURE_DIR;
  });

  /** The captain makes a link on this Mac; a view uses it and keeps the grant. */
  const pairView = async (name: string, where = at) => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at: where }]);
    await connection.settled();
    return claimLink(link, { ...AT_FIRST_LAUNCH, name });
  };

  /** Answers a task's stall card with Discard, as the scripted client, and reads the feed after. */
  const answerAndRead = async (client: ScriptedClient, taskId: (typeof stuck)[number]) => {
    const cardId = `card-stall-${taskId}`;
    const listed = await client.ask("inf:cards:list", []);
    expect(listed).toMatchObject({ t: "result", ok: true });
    const card = (listed.value as Card[]).find((candidate) => candidate.id === cardId);
    expect(card?.actions.map((action) => action.id)).toContain("discard");

    expect(await client.ask("inf:cards:act", [cardId, "discard", "chrome"])).toMatchObject({
      t: "result",
      ok: true,
    });
    await client.line(
      (line) =>
        line.t === "push" &&
        line.channel === "inf:cards" &&
        !(line.payload as Card[]).some((candidate) => candidate.id === cardId),
    );
    await waitFor(() => core.services.tasks.get(taskId)?.status === "dropped", 10_000);

    const feed = await client.ask("inf:feed:recent", []);
    expect(feed).toMatchObject({ t: "result", ok: true });
    const key = core.services.tasks.get(taskId)?.key;
    expect(
      (feed.value as FeedLine[]).filter((line) => line.taskKey === key).map((line) => line.kind),
    ).toContain("warn");
  };

  it("answers a card and reads the feed, knowing only the published file", async () => {
    const client = await startScriptedClient(await pairView("Scripted"));
    expect(client.welcome).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      catchUp: "reload",
      access: "full",
    });
    await answerAndRead(client, "contract-current");
    // Exit 0: every frame, answer and push fit the published file.
    expect(await client.close()).toBe(0);
    expect(client.lines.filter((line) => line.t === "invalid")).toEqual([]);
  });

  it("requires a client below the view floor to update before changing anything", async () => {
    // INF-1649 direction A: a view at or above VIEW_FLOOR keeps changing
    // things, so the client that must update is the one below it.
    const client = await startScriptedClient(await pairView("Below the floor"), {
      speak: `${VIEW_FLOOR - 1}.4.0`,
    });
    expect(client.welcome).toMatchObject({ protocolVersion: PROTOCOL_VERSION, access: "read" });
    expect(await client.ask("inf:feed:recent", [])).toMatchObject({ t: "result", ok: true });
    expect(
      await client.ask("inf:cards:act", ["card-stall-contract-behind", "discard", "chrome"]),
    ).toMatchObject({ t: "result", ok: false });
    expect(core.services.tasks.get("contract-behind")?.status).not.toBe("dropped");
    console.info(
      "Below-floor view reading:",
      JSON.stringify({
        welcome: client.welcome,
        taskStatus: core.services.tasks.get("contract-behind")?.status,
        cardStillOpen: (await core.dispatch("inf:cards:list", [])).some(
          (card) => card.id === "card-stall-contract-behind",
        ),
      }),
    );
    expect(await client.close()).toBe(0);
  });

  it("lets a newer client change things when the view floor its hello says reaches this home", async () => {
    // INF-1649 direction A, newer-phone "Yes, both directions": the scripted
    // client is a view, and says the file's floor unless told another.
    const client = await startScriptedClient(await pairView("Newer within its floor"), {
      speak: `${major + 1}.0.0`,
    });
    expect(client.welcome).toMatchObject({ protocolVersion: PROTOCOL_VERSION, access: "full" });
    await answerAndRead(client, "contract-newer");
    expect(await client.close()).toBe(0);
    expect(client.lines.filter((line) => line.t === "invalid")).toEqual([]);
  });

  // INF-1649 open-lists: "Yes, for what phones and views read"; review R11 asked for it at the
  // separate-process client, in a push as well as in answers. Its file predates the task kind this home sends, as the file of a
  // home before it added that member to the open lists does.
  it("reads a task of a kind its file does not list, as its own process", async () => {
    const kind = taskKindSchema.options.at(-1) as TaskKind;
    const published = JSON.parse(
      readFileSync(join(process.cwd(), "docs", "contract.json"), "utf8"),
    );
    const lists: { members: string[] }[] = published.versionRule.openLists;
    const isOpen = (members: unknown) =>
      Array.isArray(members) &&
      lists.some(
        (list) =>
          list.members.length === members.length &&
          list.members.every((member) => members.includes(member)),
      );
    const withoutKind = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutKind);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [
          key,
          (key === "enum" || key === "members") && isOpen(inner)
            ? (inner as string[]).filter((member) => member !== kind)
            : withoutKind(inner),
        ]),
      );
    };
    const file = join(scratchDir("infinitary-core-contract-file-"), "contract.json");
    writeFileSync(file, JSON.stringify(withoutKind(published)));
    const client = await startScriptedClient(await pairView("Older file"), { contract: file });
    // Added once the client listens, so the home pushes the board that carries it.
    seedTask(core.services.tasks, {
      id: "contract-newer-kind",
      title: "Run the newer kind",
      status: "queued",
      startPolicy: "on-request",
      kind,
    });
    const pushed = await client.line(
      (line) =>
        line.t === "push" &&
        (line.channel === "inf:tasks" || line.channel === "inf:tasks:delta") &&
        JSON.stringify(line.payload).includes('"contract-newer-kind"'),
    );
    expect(JSON.stringify(pushed.payload)).toContain(`"kind":"${kind}"`);
    const detail = await client.ask("inf:tasks:detail", ["contract-newer-kind"]);
    expect(detail).toMatchObject({ t: "result", ok: true });
    expect(JSON.stringify(detail.value)).toContain(`"kind":"${kind}"`);
    expect(await client.ask("inf:tasks:board", [])).toMatchObject({ t: "result", ok: true });
    expect(await client.close()).toBe(0);
    expect(client.lines.filter((line) => line.t === "invalid")).toEqual([]);
  });

  it("lets an older or newer client read the cards and the feed, and refuses its answer", async () => {
    // No client is older than the window while this contract is on its first
    // majors, so the same core is also served as a home two majors on, whose
    // majors broke views (its view floor is its own major). The newer client
    // says a floor above this home's major: its own major broke views too.
    const laterAt = `127.0.0.1:${await claimedPort()}`;
    const later = startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port: Number(laterAt.split(":")[1]),
      protocolVersion: `${major + 2}.0.0`,
      viewFloor: major + 2,
    });
    try {
      const older = await startScriptedClient(await pairView("Older", laterAt));
      const newer = await startScriptedClient(await pairView("Newer"), {
        speak: `${major + 1}.0.0`,
        floor: major + 1,
      });
      for (const client of [older, newer]) {
        expect(client.welcome.access).toBe("read");
        const listed = await client.ask("inf:cards:list", []);
        expect(
          (listed.value as Card[]).some((card) => card.id === "card-stall-contract-outside"),
        ).toBe(true);
        expect(await client.ask("inf:feed:recent", [])).toMatchObject({ t: "result", ok: true });
        const answered = await client.ask("inf:cards:act", [
          "card-stall-contract-outside",
          "discard",
          "chrome",
        ]);
        expect(answered).toMatchObject({ t: "result", ok: false });
        expect(String(answered.error)).toContain("until it is updated");
        expect(await client.close()).toBe(0);
      }
      expect(core.services.tasks.get("contract-outside")?.status).not.toBe("dropped");
      expect(
        (await core.dispatch("inf:cards:list", [])).some(
          (card) => card.id === "card-stall-contract-outside",
        ),
      ).toBe(true);
    } finally {
      await later.close();
    }
  });
});
