import { existsSync, readdirSync, statSync } from "node:fs";
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
  FileIntegrationSecrets,
  type IntegrationBinding,
  IntegrationSettingsStore,
  IntegrationsService,
  MissingSecret,
  REDACTED,
} from ".";

/**
 * INF-775 piece 4, as the captain changed it: an integration's keys are
 * kept now in a bridge following the forge's own 0600 store pattern
 * (his q3), used only by applying one to a request or handing it to a
 * program the integration starts, and never reaching a caller's answer, the
 * view Settings and the first mate read, or a card; an action that changes
 * something outside asks on a card and runs once on his click (his q5).
 *
 * The stand-in kind is an API that answers with the Authorization header
 * it received, so a binding that forwards a place's answer verbatim would
 * leak the key if the service did not replace it.
 */

const KEY = "lin_api_7Gq2v9XkP4tR8sW1";

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

/** A kind that signs in with one key: a read and a change, both through brokered use. */
function linear(secrets: FileIntegrationSecrets, base: string): IntegrationBinding {
  const send = async (path: string, method: string, body?: string) => {
    const response = await secrets.request("linear", "LINEAR_API_KEY", `${base}${path}`, {
      method,
      header: "authorization",
      prefix: "Bearer ",
      ...(body !== undefined ? { body } : {}),
    });
    return { text: await response.text() };
  };
  return {
    kind: "github",
    secrets: [{ name: "LINEAR_API_KEY", label: "Linear key" }],
    actions: [
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
    ],
    connections: () => [{ id: "linear", account: "sam", health: "ok" }],
    check: async () => {},
    remove: () => {},
    call: (_id, action, input) =>
      action === "search"
        ? send(`/search?q=${encodeURIComponent((input as { query: string }).query)}`, "GET")
        : send("/issues", "POST", JSON.stringify(input)),
  };
}

async function fixture() {
  const dir = join(scratchDir("fm-integration-keys-"), "integrations");
  const secrets = new FileIntegrationSecrets(join(dir, "secrets"));
  const api = await standIn();
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, { id: "task-1", title: "File the bug", status: "idle" });
  const pushed: string[] = [];
  const integrations = new IntegrationsService({
    bindings: [linear(secrets, api.base)],
    store: new IntegrationSettingsStore(dir),
    secrets,
    asks: {
      keep: (taskId, ask) => tasks.keepWriteAsk(taskId, ask),
      take: (taskId, askId) => tasks.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) => tasks.recordWriteAskOutcome(taskId, askId, outcome),
    },
    push: (view) => pushed.push(JSON.stringify(view)),
  });
  // The kinds are a closed list; the stand-in borrows one and takes its own name.
  integrations.configure("linear", { name: "Linear" });
  return { dir, secrets, api, tasks, integrations, pushed };
}

describe("integration keys", () => {
  it("keeps a key in a 0600 file in a 0700 folder, shows only that it is kept, and forgets it with the integration", async () => {
    const { dir, integrations, pushed } = await fixture();
    expect(integrations.view().integrations[0]?.secrets).toEqual([
      { name: "LINEAR_API_KEY", label: "Linear key", kept: false },
    ]);
    expect(integrations.rosterLine()).toContain("needs a key entered in Settings");

    const view = integrations.setSecret("linear", "LINEAR_API_KEY", KEY);
    expect(view.integrations[0]?.secrets).toEqual([
      { name: "LINEAR_API_KEY", label: "Linear key", kept: true },
    ]);
    const folder = join(dir, "secrets", "linear");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "secrets.json")).mode & 0o777).toBe(0o600);
    // What Settings, the first mate and a crewmate's discovery read never holds it.
    for (const read of [
      JSON.stringify(view),
      ...pushed,
      JSON.stringify(integrations.roster()),
      JSON.stringify(integrations.show("Linear")),
      integrations.rosterLine() ?? "",
    ])
      expect(read).not.toContain(KEY);
    expect(integrations.show("linear")).toMatchObject({
      keys: [{ name: "Linear key", kept: true }],
    });
    expect(() => integrations.setSecret("linear", "OTHER", "x")).toThrow("has no key named OTHER");

    integrations.remove("linear");
    expect(existsSync(folder)).toBe(false);
  });

  it("refuses an action whose key is not entered before anything reaches the place", async () => {
    const { api, integrations } = await fixture();
    const answer = await integrations.forTask("task-1").call("linear", "search", { query: "bug" });
    expect(answer.refused).toBe("refused");
    expect(answer.text).toContain("needs Linear key");
    expect(answer.text).toContain("Settings → Integrations");
    expect(api.seen).toEqual([]);
  });

  it("applies the key to one request and replaces it in the answer, even when the place sends it back", async () => {
    const { api, integrations } = await fixture();
    integrations.setSecret("linear", "LINEAR_API_KEY", KEY);
    const answer = await integrations.forTask("task-1").call("linear", "search", { query: "bug" });
    expect(api.seen).toEqual([
      expect.objectContaining({ method: "GET", authorization: `Bearer ${KEY}` }),
    ]);
    expect(answer.refused).toBeUndefined();
    expect(answer.text).not.toContain(KEY);
    expect(JSON.parse(answer.text).youSent.authorization).toBe(`Bearer ${REDACTED}`);
  });

  it("hands a program the key it is started with, and refuses a slot with none kept", async () => {
    const { secrets } = await fixture();
    expect(() => secrets.launchEnv("linear", { LINEAR_API_KEY: "LINEAR_API_KEY" })).toThrow(
      MissingSecret,
    );
    secrets.put("linear", "LINEAR_API_KEY", KEY);
    expect(secrets.launchEnv("linear", { LINEAR_API_KEY: "LINEAR_API_KEY" })).toEqual({
      LINEAR_API_KEY: KEY,
    });
  });

  it("keeps a change on the task as an ask that runs once on the captain's click, and refuses the first mate's", async () => {
    const { api, tasks, integrations } = await fixture();
    integrations.setSecret("linear", "LINEAR_API_KEY", KEY);

    const firstmate = await integrations.call({ kind: "firstmate" }, "linear", "create", {
      title: "Crash on open",
    });
    expect(firstmate.refused).toBe("refused");
    expect(firstmate.text).toContain("Start a crewmate whose brief names the call");

    const kept = await integrations
      .forTask("task-1")
      .call("linear", "create", { title: "Crash on open" });
    expect(api.seen).toEqual([]);
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    expect(ask).toMatchObject({
      kind: "integration",
      integration: "linear",
      place: "Linear",
      action: "create",
      input: JSON.stringify({ title: "Crash on open" }),
    });
    expect(kept.text).toContain(`{"kind":"request_write","ask":"${ask?.id}"}`);
    // The card's strip says what the click runs, with its input and never the key.
    const strip = ask ? writeAskStrip(ask) : "";
    expect(strip).toContain("Your click runs this on Linear, once");
    expect(strip).toContain("Crash on open");
    expect(strip).not.toContain(KEY);

    const click = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(click.ok).toBe(true);
    expect(click.outcome).toEqual({ kind: "ran" });
    expect(api.seen).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/issues",
        authorization: `Bearer ${KEY}`,
        body: JSON.stringify({ title: "Crash on open" }),
      }),
    ]);
    expect(click.answer).not.toContain(KEY);
    expect(tasks.get("task-1")?.delivery?.writeAsks?.[0]?.outcome).toEqual({ kind: "ran" });

    const again = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(again.ok).toBe(false);
    expect(again.outcome).toMatchObject({ kind: "refused" });
    expect(api.seen).toHaveLength(1);
  });

  it("runs nothing on a click when the action was turned off after it was asked", async () => {
    const { api, tasks, integrations } = await fixture();
    integrations.setSecret("linear", "LINEAR_API_KEY", KEY);
    await integrations.forTask("task-1").call("linear", "create", { title: "Crash on open" });
    const ask = tasks.get("task-1")?.delivery?.writeAsks?.[0];
    integrations.configure("linear", { actions: { create: false } });

    const click = await integrations.sendAsk("task-1", ask?.id ?? "");
    expect(click.outcome).toEqual({ kind: "refused", why: "Linear's action create is off" });
    expect(api.seen).toEqual([]);
  });

  it("forgets one key without touching the others' folders", async () => {
    const { dir, integrations } = await fixture();
    integrations.setSecret("linear", "LINEAR_API_KEY", KEY);
    const view = integrations.setSecret("linear", "LINEAR_API_KEY", null);
    expect(view.integrations[0]?.secrets?.[0]?.kept).toBe(false);
    expect(readdirSync(join(dir, "secrets"))).toEqual([]);
  });
});
