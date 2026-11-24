import { join } from "node:path";
import type { CustomFileConnection, CustomFileDefinition } from "@shared/customApiFile";
import { expect, it } from "vitest";
import type { SessionEvent } from "../session/session";
import { fixture, input, vault } from "./customApiAccountsFixture";
import { createPiSessionFactory } from "./session";

const NAME = "team-gateway";

/** A connection approved here from the file, as Settings saves it: checked, with its own key. */
async function approved(models: CustomFileDefinition["models"]) {
  const api = await fixture();
  const world = vault();
  const definition: CustomFileDefinition = {
    label: "Team gateway",
    baseUrl: api.baseUrl,
    protocol: "openai-completions",
    headers: [],
    models,
  };
  const draft = world.vault.customPrepare({
    ...input(api.baseUrl),
    label: definition.label,
    models,
    file: NAME,
  });
  for (const model of models) await world.vault.customCheck(draft.draftId ?? "", model.id);
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const apply = async (connections: CustomFileConnection[] | null) => {
    await Promise.all(world.vault.applyCustomFile(connections));
  };
  const reading = (next: CustomFileDefinition): CustomFileConnection[] => [
    { name: NAME, warnings: [], definition: next },
  ];
  const view = () => world.vault.customViews().find((entry) => entry.accountId === account.id);
  const usable = () =>
    world.vault
      .availableModels()
      .filter((model) => model.provider === account.providerId)
      .map((model) => model.id);
  return { api, world, account, definition, apply, reading, view, usable };
}

const operator = { id: "operator-model", context: 65536, output: 1024, input: ["text" as const] };

it("applies a name and price from the file at once, with no request to the server", async () => {
  const { api, world, account, definition, apply, reading, view, usable } = await approved([
    operator,
  ]);
  const sent = api.requests.length;
  await apply(
    reading({
      ...definition,
      label: "Renamed gateway",
      models: [{ ...operator, name: "Operator", cost: { input: 3, output: 15 } }],
    }),
  );
  expect(api.requests.length).toBe(sent);
  expect(view()).toMatchObject({
    label: "Renamed gateway",
    file: { name: NAME, state: "current" },
    models: [
      { id: "operator-model", name: "Operator", cost: { input: 3, output: 15 }, checked: true },
    ],
  });
  expect(world.vault.list().find((entry) => entry.id === account.id)?.label).toBe(
    "Renamed gateway",
  );
  expect(usable()).toEqual(["operator-model"]);
});

it("checks a model again, with the saved key, when the file changes its limits", async () => {
  const { api, definition, apply, reading, view, usable } = await approved([operator]);
  const sent = api.requests.length;
  await apply(reading({ ...definition, models: [{ ...operator, context: 32768 }] }));
  const checks = api.requests.slice(sent);
  expect(checks.length).toBeGreaterThan(0);
  expect(
    checks.every((request) => request.authorization === "Bearer opaque-synthetic-secret"),
  ).toBe(true);
  expect(view()?.models).toMatchObject([{ id: "operator-model", context: 32768, checked: true }]);
  expect(usable()).toEqual(["operator-model"]);
});

it("pauses a connection whose address changed or that left the file, until the file agrees again", async () => {
  const { api, definition, apply, reading, view, usable } = await approved([operator]);
  const sent = api.requests.length;

  await apply(reading({ ...definition, baseUrl: "https://elsewhere.example.com/v1" }));
  expect(view()?.file).toEqual({ name: NAME, state: "changed" });
  expect(usable()).toEqual([]);

  await apply(
    reading({ ...definition, headers: [{ name: "X-Tenant-Id", secret: false, value: "b" }] }),
  );
  expect(view()?.file).toEqual({ name: NAME, state: "changed" });
  expect(usable()).toEqual([]);

  await apply(reading(definition));
  expect(view()?.file).toEqual({ name: NAME, state: "current" });
  expect(usable()).toEqual(["operator-model"]);

  // Gone from the file: paused, never deleted.
  await apply([]);
  expect(view()).toMatchObject({
    file: { name: NAME, state: "missing" },
    models: [{ checked: true }],
  });
  expect(usable()).toEqual([]);

  // No file chosen any more: nothing holds it.
  await apply(null);
  expect(usable()).toEqual(["operator-model"]);
  expect(api.requests.length).toBe(sent);
});

it.each([
  { input: ["text" as const], pictures: 0 },
  { input: ["text" as const, "image" as const], pictures: 1 },
])(
  "sends a picture in a model's check only when the file says it reads $input",
  async ({ input: kinds, pictures }) => {
    const { api } = await approved([{ ...operator, input: kinds }]);
    const sent = api.requests.filter((request) =>
      JSON.stringify(request.body).includes("data:image/png;base64,"),
    );
    expect(sent).toHaveLength(pictures);
  },
);

it("compacts a long session at the reserve the file states, instead of Pi's", async () => {
  const run = async (compaction?: { reserveTokens: number }) => {
    const api = await fixture();
    api.count();
    const world = vault();
    const models = [{ id: "operator-model", context: 131072, output: 8192 }];
    const draft = world.vault.customPrepare({
      ...input(api.baseUrl),
      models,
      file: NAME,
      ...(compaction ? { compaction } : {}),
    });
    await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const factory = createPiSessionFactory({ agentDir: join(world.paths.userData, "agent") });
    const session = await factory.open({
      machine: "local",
      owner: "synthetic-session",
      cwd: world.paths.userData,
      binding: { backend: "pi", accountId: account.id, runtime },
      model: { provider: account.providerId, id: "operator-model" },
      thinking: { level: "off" },
      instructions: { base: "Synthetic session instruction" },
      builtins: "none",
      tools: [],
      shape: { turns: "rolling", record: { dir: join(world.paths.userData, "sessions") } },
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    // About 9,600 tokens a turn: five turns stay far under Pi's own trigger
    // (131,072 - 8,192 output - 16,384 reserved), and pass the stated one.
    const file = "export const line = 'a line of synthetic source code';\n".repeat(700);
    try {
      for (let turn = 1; turn <= 5; turn++) await session.prompt(`Turn ${turn}:\n${file}`);
    } finally {
      session.dispose();
      await session.closed();
    }
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    return events.filter(
      (event) => event.type === "tool_end" && event.callId === "synthetic-session:compaction",
    ).length;
  };
  expect(await run()).toBe(0);
  expect(await run({ reserveTokens: 90000 })).toBeGreaterThan(0);
});
