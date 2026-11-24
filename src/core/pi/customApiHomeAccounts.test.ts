import type { CustomFileDefinition, CustomHomeDefinition } from "@shared/customApiFile";
import { expect, it } from "vitest";
import { fixture, input, vault } from "./customApiAccountsFixture";

/**
 * INF-6581's plan, piece 3, on the computer that runs work: a connection it
 * approved from one of the first mate's computer's own keeps its own key and
 * follows what that computer sends. Names and prices apply at once, a checked
 * field checks that model again here, and a new address, protocol or headers,
 * or the home's connection gone, pause it until it is approved again.
 */

const HOME_ACCOUNT = "acct-home-gateway";
const operator = { id: "operator-model", context: 65536, output: 1024, input: ["text" as const] };

async function approvedFromHome() {
  const api = await fixture();
  const world = vault();
  const definition: CustomFileDefinition = {
    label: "Team gateway",
    baseUrl: api.baseUrl,
    protocol: "openai-completions",
    headers: [],
    models: [operator],
  };
  const draft = world.vault.customPrepare({
    ...input(api.baseUrl),
    label: definition.label,
    models: [operator],
    home: HOME_ACCOUNT,
  });
  await world.vault.customCheck(draft.draftId ?? "", operator.id);
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const sent = (next: CustomFileDefinition | undefined): CustomHomeDefinition[] =>
    next ? [{ name: HOME_ACCOUNT, definition: next }] : [];
  const apply = (next: CustomFileDefinition | undefined) =>
    Promise.all(world.vault.applyCustomHome(sent(next)));
  const view = () => world.vault.customViews().find((entry) => entry.accountId === account.id);
  const usable = () =>
    world.vault
      .availableModels()
      .filter((model) => model.provider === account.providerId)
      .map((model) => model.id);
  return { api, world, definition, apply, view, usable };
}

it("takes a name and price the home sends at once, and checks a model again with its own key when its limits change", async () => {
  const { api, definition, apply, view, usable } = await approvedFromHome();
  const before = api.requests.length;
  await apply({
    ...definition,
    label: "Renamed gateway",
    models: [{ ...operator, name: "Operator", cost: { input: 3, output: 15 } }],
  });
  expect(api.requests.length).toBe(before);
  expect(view()).toMatchObject({
    label: "Renamed gateway",
    home: { name: HOME_ACCOUNT, state: "current" },
    models: [{ id: "operator-model", name: "Operator", cost: { input: 3, output: 15 } }],
  });
  expect(usable()).toEqual(["operator-model"]);

  await apply({ ...definition, models: [{ ...operator, context: 32768 }] });
  const checks = api.requests.slice(before);
  expect(checks.length).toBeGreaterThan(0);
  expect(
    checks.every((request) => request.authorization === "Bearer opaque-synthetic-secret"),
  ).toBe(true);
  expect(view()?.models).toMatchObject([{ id: "operator-model", context: 32768, checked: true }]);
});

it("pauses a connection the home moved or removed, and never lets a connection file release it", async () => {
  const { api, world, definition, apply, view, usable } = await approvedFromHome();
  const before = api.requests.length;

  await apply({ ...definition, baseUrl: "https://elsewhere.example.com/v1" });
  expect(view()?.home).toEqual({ name: HOME_ACCOUNT, state: "changed" });
  expect(usable()).toEqual([]);

  // Choosing no connection file here ends only the file's holds.
  await Promise.all(world.vault.applyCustomFile(null));
  expect(usable()).toEqual([]);

  await apply(definition);
  expect(view()?.home).toEqual({ name: HOME_ACCOUNT, state: "current" });
  expect(usable()).toEqual(["operator-model"]);

  // Gone from the home: paused, never deleted, with its checks kept.
  await apply(undefined);
  expect(view()).toMatchObject({
    home: { name: HOME_ACCOUNT, state: "missing" },
    models: [{ checked: true }],
  });
  expect(usable()).toEqual([]);
  expect(api.requests.length).toBe(before);
});
