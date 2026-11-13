import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writeAskStrip } from "../orchestrator/requestStrips";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import {
  type IntegrationActionSpec,
  type IntegrationBinding,
  IntegrationSettingsStore,
  IntegrationsService,
} from ".";

/**
 * INF-775's q5, as the captain chose it: an action that changes something
 * outside asks on a card and runs once on the captain's click. The stand-in kind is
 * an API that records every request it gets.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

/** A stand-in API: every request is recorded and answered with what it carried. */
async function standIn() {
  const seen: { method: string; url: string; authorization?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      };
      seen.push(entry);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, youSent: entry }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The stand-in kind's actions: a read and a change. */
const ACTIONS: IntegrationActionSpec[] = [
  {
    name: "search",
    label: "Search issues",
    effect: "reads",
    description: "Search issues.",
    input: z.strictObject({ query: z.string() }),
  },
  {
    name: "create",
    label: "Create an issue",
    effect: "changes",
    description: "Create an issue.",
    input: z.strictObject({ title: z.string() }),
  },
];

/** A kind with a read and a change, each one request to the stand-in. */
function linear(base: string): IntegrationBinding {
  const send = async (path: string, method: string, body?: string) => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body !== undefined ? { body } : {}),
    });
    return { text: await response.text() };
  };
  return {
    kind: "github",
    connections: () => [{ id: "linear", account: "sam", health: "ok", actions: ACTIONS }],
    check: async () => {},
    remove: () => {},
    call: (_id, action, input) =>
      action === "search"
        ? send(`/search?q=${encodeURIComponent((input as { query: string }).query)}`, "GET")
        : send("/issues", "POST", JSON.stringify(input)),
  };
}

async function fixture() {
  const dir = join(scratchDir("fm-integration-asks-"), "integrations");
  const api = await standIn();
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "task-1", title: "File the bug", status: "idle" });
  const pushed: string[] = [];
  const integrations = new IntegrationsService({
    bindings: [linear(api.base)],
    store: new IntegrationSettingsStore(dir),
    asks: {
      keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
      take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) =>
        tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
    },
    push: (view) => pushed.push(JSON.stringify(view)),
  });
  // The kinds are a closed list; the stand-in borrows one and takes its own name.
  integrations.configure("linear", { name: "Linear" });
  return { api, tasks, integrations };
}

describe("integration asks", () => {
  it("keeps a change on the task as an ask that runs once on the captain's click, and refuses the first mate's", async () => {
    const { api, tasks, integrations } = await fixture();

    const firstmate = await integrations.call(
      { kind: "firstmate" },
      "linear",
      "create",
      {
        title: "Crash on open",
      },
      "To perform the task’s requested action.",
    );
    expect(firstmate.refused).toBe("refused");
    expect(firstmate.text).toContain("Start a crewmate whose brief names the call");

    const kept = await integrations
      .forTask("task-1")
      .call(
        "linear",
        "create",
        { title: "Crash on open" },
        undefined,
        "To perform the task’s requested action.",
      );
    expect(api.seen).toEqual([]);
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    expect(ask).toMatchObject({
      kind: "integration",
      integration: "linear",
      place: "Linear",
      action: "create",
      input: JSON.stringify({ title: "Crash on open" }),
    });
    expect(kept.text).toContain(`The app raised its approval card for ask ${ask?.id}`);
    // Kept is not run, so it answers as a refusal (the captain's INF-824 choice).
    expect(kept.refused).toBe("refused");
    // The card's strip says what the click runs, with its input.
    const strip = ask ? writeAskStrip(ask) : "";
    expect(strip).toContain("Your click runs this on Linear, once");
    expect(strip).toContain("Crash on open");

    const click = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(click.ok).toBe(true);
    expect(click.outcome).toEqual({ kind: "ran" });
    expect(api.seen).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/issues",
        body: JSON.stringify({ title: "Crash on open" }),
      }),
    ]);
    expect(tasks.get("task-1")?.delivery?.writeAsks?.[0]?.outcome).toEqual({ kind: "ran" });

    const again = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(again.ok).toBe(false);
    expect(again.outcome).toMatchObject({ kind: "refused" });
    expect(api.seen).toHaveLength(1);
  });

  it("runs nothing on a click when the action was turned off after it was asked", async () => {
    const { api, tasks, integrations } = await fixture();
    await integrations
      .forTask("task-1")
      .call(
        "linear",
        "create",
        { title: "Crash on open" },
        undefined,
        "To perform the task’s requested action.",
      );
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    integrations.configure("linear", { actions: { create: false } });

    const click = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(click.outcome).toEqual({ kind: "refused", why: "Linear's action create is off" });
    expect(api.seen).toEqual([]);
  });
});
