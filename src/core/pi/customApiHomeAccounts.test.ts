import type { CustomApiInput } from "@shared/customApi";
import {
  type CustomFileDefinition,
  type CustomHomeDefinition,
  customHomeDefinition,
} from "@shared/customApiFile";
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
  /** Saves a connection here as that computer's form does, checked, then applies the home's last send again as its save does. */
  const save = async (fields: Partial<CustomApiInput> & { baseUrl: string }) => {
    const draft = world.vault.customPrepare({
      ...input(fields.baseUrl),
      label: definition.label,
      models: [operator],
      ...fields,
    });
    await world.vault.customCheck(draft.draftId ?? "", operator.id);
    const saved = await world.vault.customSave(draft.draftId ?? "", false);
    await Promise.all(world.vault.reapplyCustomHome());
    return saved;
  };
  return { api, world, account, definition, apply, view, usable, save };
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

// A save applies the home's last send again, which may predate a connection
// approved since; that send does not hold the newer connection as gone.
it("keeps a second connection approved from the home's current until the home says otherwise", async () => {
  const { api, world, definition, apply, save } = await approvedFromHome();
  await apply(definition);
  const second = await save({ baseUrl: api.baseUrl, home: "acct-home-other" });
  expect(world.vault.customViews().find((entry) => entry.accountId === second.id)?.home).toEqual({
    name: "acct-home-other",
    state: "current",
  });
  expect(
    world.vault
      .availableModels()
      .filter((model) => model.provider === second.providerId)
      .map((model) => model.id),
  ).toEqual(["operator-model"]);
});

// An edit that stops following the home ends the pause the home's connection put on it.
it("serves a connection again once an edit stops it following a home connection that is gone", async () => {
  const { api, account, apply, view, usable, save } = await approvedFromHome();
  await apply(undefined);
  expect(usable()).toEqual([]);
  await save({ baseUrl: api.baseUrl, replaceAccountId: account.id });
  expect(view()?.home).toBeUndefined();
  expect(usable()).toEqual(["operator-model"]);
});

it("pauses a connection there when the home's connection file moves its address, and approving it again there leaves one working connection", async () => {
  const there = await approvedFromHome();
  const moved = await fixture();
  // The home approved this connection from its connection file, which now names a new address.
  const home = vault();
  const draft = home.vault.customPrepare({
    ...input(there.api.baseUrl),
    label: there.definition.label,
    models: [operator],
    file: "team-gateway",
  });
  await home.vault.customCheck(draft.draftId ?? "", operator.id);
  const homeAccount = await home.vault.customSave(draft.draftId ?? "", false);
  const reading = [
    {
      name: "team-gateway",
      warnings: [],
      definition: { ...there.definition, baseUrl: moved.baseUrl },
    },
  ];
  await Promise.all(home.vault.applyCustomFile(reading));
  const homeView = home.vault.customViews().find((entry) => entry.accountId === homeAccount.id);
  expect(homeView?.file?.state).toBe("changed");
  const sent = homeView && customHomeDefinition(homeView, { connections: reading });
  expect(sent?.baseUrl).toBe(moved.baseUrl);

  await there.apply(sent);
  expect(there.view()?.home?.state).toBe("changed");
  expect(there.usable()).toEqual([]);

  const again = await there.save({ baseUrl: moved.baseUrl, home: HOME_ACCOUNT });
  const views = there.world.vault.customViews();
  expect(views.find((entry) => entry.accountId === again.id)?.home).toEqual({
    name: HOME_ACCOUNT,
    state: "current",
  });
  expect(there.view()?.home?.state).toBe("changed");
  expect(
    there.world.vault
      .availableModels()
      .filter((model) => model.provider.startsWith("fm-custom-"))
      .map((model) => model.provider),
  ).toEqual([again.providerId]);
});
