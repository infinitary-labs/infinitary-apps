import type { AccountView } from "@shared/accounts";
import type { Card } from "@shared/cards";
import { DEVICE_SETUP_ACTIONS, deviceSetupCardId } from "@shared/deviceSetup";
import type { DeviceView } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { forgeOf } from "@shared/forge";
import { inLanguage } from "@shared/i18n/current";
import { type RepoView, repoHostFrom } from "@shared/repos";
import type { ComputerSignIns } from "@shared/signIns";
import { describe, expect, it } from "vitest";
import { DeviceSetup } from "./deviceSetup";

/**
 * The setup card a computer that runs work gets at join (docs/devices.md,
 * "Finishing its setup"): raised from typed facts, revised as the computer
 * reports its sign-ins and a project is set to run there, down by itself
 * with one feed line once every row is done, and never again after Not now.
 */

const MINI = {
  id: "d1",
  kind: "work" as const,
  name: "Mac mini",
  user: "sam",
  onThisMac: false,
  inReach: true,
};
const CARD = deviceSetupCardId("d1");
const FORGE_CARD = "card-forge-github.com-d1";

function account(id: string, providerId: string): AccountView {
  return {
    id,
    providerId,
    kind: "subscription_oauth",
    label: id,
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: 1,
  };
}

function repo(name: string, origin: string | null, runsOn: string | null): RepoView {
  return {
    id: name,
    name,
    path: `/tmp/${name}`,
    setupKind: "adopt",
    kind: "project",
    origin,
    host: origin ? repoHostFrom(forgeOf(origin)) : null,
    delivery: "direct-pr",
    autonomy: false,
    rigor: null,
    runsOn,
  };
}

function world() {
  const raised: Card["id"][] = [];
  const stack = new Map<string, Omit<Card, "author" | "priority" | "status" | "createdAt">>();
  const stored = new Map<string, Pick<Card, "body" | "actions">>();
  const chosen = new Map<string, string>();
  const withdrawn: [string, string][] = [];
  const events: FmEvent[] = [];
  const said = new Map<string, ComputerSignIns | null>();
  const asked: string[] = [];
  const unanswered = new Set<string>();
  const repos: RepoView[] = [];
  const forge: string[] = [];
  const devices: Pick<
    DeviceView,
    "id" | "kind" | "name" | "user" | "onThisMac" | "inReach" | "workSetup"
  >[] = [MINI];
  const gate = { up: false };
  const setup = new DeviceSetup({
    devices: () => devices,
    repos: { list: () => repos },
    signIns: {
      lastSaid: (deviceId) => said.get(deviceId) ?? null,
      didNotAnswer: (deviceId) => unanswered.has(deviceId),
      signInsOf: async (deviceId) => {
        asked.push(deviceId);
        return said.get(deviceId) ?? null;
      },
    },
    cards: {
      raise: (card) => {
        raised.push(card.id);
        stack.set(card.id, card);
        stored.set(card.id, card);
        chosen.delete(card.id);
      },
      withdraw: (id, reason) => {
        if (stack.delete(id)) withdrawn.push([id, reason]);
      },
      has: (id) => stack.has(id),
      stored: (id) => stored.get(id),
      chosenAction: (id) => chosen.get(id),
    },
    broadcastEvent: (event) => events.push(event),
    held: () => gate.up,
    forgeNeeded: (deviceId, host, repo) => forge.push(`needed ${deviceId} ${host} ${repo.name}`),
    forgeReady: (deviceId, host) => forge.push(`ready ${deviceId} ${host}`),
  });
  /** The captain's click on the card's own button: the card resolves and remembers the action. */
  const click = (action: string) => {
    stack.delete(CARD);
    chosen.set(CARD, action);
  };
  const rows = () =>
    [...(stack.get(CARD)?.body.matchAll(/data-setup-row="(\w+)" data-done="(\w+)"/g) ?? [])].map(
      ([, id, done]) => `${id}:${done}`,
    );
  const notes = () =>
    events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
  return {
    setup,
    raised,
    stack,
    withdrawn,
    events,
    said,
    asked,
    unanswered,
    repos,
    forge,
    devices,
    gate,
    click,
    rows,
    notes,
  };
}

const CODEX = {
  id: "openai-codex",
  name: "Codex",
  tier: "subscription",
  authTypes: ["oauth"],
  connected: false,
  billedPerToken: false,
} as const;
const providers = [{ ...CODEX, authTypes: [...CODEX.authTypes] }];

const GITHUB_OFFERED = { hosts: [{ host: "github.com", name: "GitHub" }], signIns: [] };
const GITHUB_SIGNED_IN = {
  hosts: [{ host: "github.com", name: "GitHub" }],
  signIns: [{ host: "github.com", name: "GitHub", login: "octo", state: "ok" as const, since: 5 }],
};

describe("finishing a computer's setup", () => {
  it("raises the card at join from what the join found, with every row open when it already reported", () => {
    const at = world();
    at.said.set("d1", { providers, accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.setup.joined(MINI, { git: true, claudeCode: true }, false);
    expect(at.raised).toEqual([CARD]);
    expect(at.stack.get(CARD)).toMatchObject({
      title: "Finish setting up Mac mini",
      meta: "Mac mini",
    });
    expect(at.rows()).toEqual(["subscription:false", "github:false", "project:false"]);
    expect(at.stack.get(CARD)?.actions.map((action) => action.id)).toEqual([
      DEVICE_SETUP_ACTIONS.subscription,
      DEVICE_SETUP_ACTIONS.github,
      DEVICE_SETUP_ACTIONS.project,
      DEVICE_SETUP_ACTIONS.notNow,
    ]);
  });

  it("follows work reach and the report, without offering a stale link after disconnect", () => {
    const at = world();
    const blocked = {
      ...MINI,
      kind: "mac" as const,
      inReach: false,
      workSetup: { state: "blocked", reason: "background-off" } as const,
    };
    at.devices[0] = blocked;
    inLanguage("fr", () => at.setup.joined(blocked, undefined, false));
    const card = () => at.stack.get(CARD);
    const actions = () => card()?.actions.map(({ id }) => id);
    expect(card()?.body).toContain("is not allowed to run in the background");
    expect(actions()).toEqual([DEVICE_SETUP_ACTIONS.notNow]);
    at.devices[0] = MINI;
    at.setup.reachChanged(at.devices);
    expect(card()?.body).toContain('data-setup-wait="sign-ins"');
    at.unanswered.add("d1");
    at.setup.refresh("d1");
    expect(card()?.body).toContain("did not say what it is signed in to");
    expect(actions()).toEqual([DEVICE_SETUP_ACTIONS.notNow]);
    at.unanswered.delete("d1");
    expect(actions()).toEqual([DEVICE_SETUP_ACTIONS.notNow]);
    at.said.set("d1", { providers, accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.setup.signInsChanged("d1");
    expect(actions()).toContain(DEVICE_SETUP_ACTIONS.github);
    expect(actions()).toContain(DEVICE_SETUP_ACTIONS.subscription);
    at.devices[0] = { ...MINI, inReach: false };
    at.setup.reachChanged(at.devices);
    expect(card()?.body).toContain("not connected for work yet");
    expect(actions()).toEqual([DEVICE_SETUP_ACTIONS.notNow]);
  });

  // A first mate set up from another computer's first launch has no
  // subscription yet: that window's subscription step comes first, and the
  // card for the computer that joined it follows.
  it("waits while no subscription answers the Firstmate, then goes up with the rows as they stand", () => {
    const at = world();
    at.gate.up = true;
    at.devices.push({ ...MINI, id: "d2", name: "Mac Studio" });
    at.setup.joined(MINI, { git: true, claudeCode: true }, false);
    at.said.set("d1", { providers, accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.setup.signInsChanged("d1");
    at.setup.reachChanged(at.devices);
    expect(at.raised).toEqual([]);
    at.said.set("d1", {
      providers: [],
      accounts: [account("acct", "openai-codex")],
      quota: null,
      forges: GITHUB_OFFERED,
    });
    at.setup.signInsChanged("d1");
    expect(at.raised).toEqual([]);
    at.gate.up = false;
    at.setup.firstmateAnswers();
    // Only the computer that joined this run: Mac Studio joined before it and never had the card.
    expect(at.raised).toEqual([CARD]);
    expect(at.rows()).toEqual(["subscription:true", "github:false", "project:false"]);
    at.setup.firstmateAnswers();
    expect(at.raised).toEqual([CARD]);
  });

  it("raises nothing for a Mac that controls this Firstmate, or a computer that found this Mac again", () => {
    const at = world();
    at.setup.joined({ ...MINI, id: "v1", kind: "view" }, undefined, false);
    at.setup.joined(MINI, { git: true, claudeCode: true }, true);
    expect(at.raised).toEqual([]);
  });

  it("asks a computer its sign-ins when it comes into reach with its card still asking", () => {
    const at = world();
    at.setup.joined(MINI, undefined, false);
    at.setup.contact({ deviceId: "d1", contact: "in-reach" });
    expect(at.asked).toEqual(["d1"]);
    // Once it has said, nothing asks again.
    at.said.set("d1", { providers: [], accounts: [], quota: null });
    at.setup.contact({ deviceId: "d1", contact: "in-reach" });
    expect(at.asked).toEqual(["d1"]);
  });

  it("revises the card only when a row moves, and leaves it alone when the computer says the same again", () => {
    const at = world();
    at.said.set("d1", { providers, accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.setup.joined(MINI, undefined, false);
    at.setup.signInsChanged("d1");
    expect(at.raised).toEqual([CARD]);
    at.said.set("d1", {
      providers: [],
      accounts: [account("acct", "openai-codex")],
      quota: null,
      forges: GITHUB_OFFERED,
    });
    at.setup.signInsChanged("d1");
    expect(at.raised).toEqual([CARD, CARD]);
    expect(at.rows()).toEqual(["subscription:true", "github:false", "project:false"]);
    expect(at.stack.get(CARD)?.actions.map((action) => action.id)).toEqual([
      DEVICE_SETUP_ACTIONS.github,
      DEVICE_SETUP_ACTIONS.project,
      DEVICE_SETUP_ACTIONS.notNow,
    ]);
  });

  it("comes back after a button resolved it once a fact changes, and comes down done with one feed line", () => {
    const at = world();
    at.said.set("d1", { providers, accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.setup.joined(MINI, undefined, false);
    at.click(DEVICE_SETUP_ACTIONS.subscription);
    // A disconnect, an unanswered read and a reconnect with the same facts
    // never reopen a card the captain already answered (INF-4843).
    at.devices[0] = { ...MINI, inReach: false };
    at.setup.reachChanged(at.devices);
    expect(at.stack.has(CARD)).toBe(false);
    at.devices[0] = MINI;
    at.setup.reachChanged(at.devices);
    expect(at.stack.has(CARD)).toBe(false);
    at.said.set("d1", null);
    at.unanswered.add("d1");
    at.setup.refresh("d1");
    expect(at.stack.has(CARD)).toBe(false);
    at.unanswered.delete("d1");
    at.said.set("d1", { providers, accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.setup.signInsChanged("d1");
    expect(at.stack.has(CARD)).toBe(false);
    at.said.set("d1", {
      providers: [],
      accounts: [account("acct", "openai-codex")],
      quota: null,
      forges: GITHUB_SIGNED_IN,
    });
    at.setup.signInsChanged("d1");
    expect(at.rows()).toEqual(["subscription:true", "github:true", "project:false"]);
    expect(at.forge).toEqual(["ready d1 github.com"]);
    at.repos.push(repo("website", "https://github.com/octo/website.git", "d1"));
    at.setup.runsOnChanged(at.repos[0] as RepoView);
    expect(at.stack.has(CARD)).toBe(false);
    expect(at.withdrawn).toContainEqual([CARD, "set up"]);
    expect(at.notes()).toEqual(["Mac mini is set up. It runs website with its own sign-ins."]);
    at.setup.signInsChanged("d1");
    expect(at.raised).toEqual([CARD, CARD]);
  });

  it("stays down after Not now, whatever the computer says later", () => {
    const at = world();
    at.setup.joined(MINI, undefined, false);
    at.click(DEVICE_SETUP_ACTIONS.notNow);
    at.said.set("d1", { providers: [], accounts: [account("acct", "xai")], quota: null });
    at.setup.signInsChanged("d1");
    at.setup.contact({ deviceId: "d1", contact: "in-reach" });
    expect(at.raised).toEqual([CARD]);
    expect(at.asked).toEqual([]);
  });

  it("raises nothing for a computer that joined before this Mac started and never had the card", () => {
    const at = world();
    at.said.set("d1", { providers: [], accounts: [], quota: null });
    at.setup.signInsChanged("d1");
    at.setup.contact({ deviceId: "d1", contact: "in-reach" });
    expect(at.raised).toEqual([]);
    expect(at.notes()).toEqual([]);
  });

  it("takes the GitHub card down when the setup card asks for the same sign-in, and asks for it when the setup card does not", () => {
    const at = world();
    at.stack.set(FORGE_CARD, {
      id: FORGE_CARD,
      title: "Sign in to GitHub on Mac mini",
      meta: "",
      body: "",
      actions: [],
    });
    at.setup.joined(MINI, undefined, false);
    expect(at.withdrawn).toContainEqual([FORGE_CARD, "the setup card asks for it"]);
    // A GitHub project set to run on a computer with no GitHub sign-in of its own.
    at.said.set("d1", { providers: [], accounts: [], quota: null, forges: GITHUB_OFFERED });
    at.repos.push(repo("website", "https://github.com/octo/website.git", "d1"));
    at.setup.runsOnChanged(at.repos[0] as RepoView);
    return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      expect(at.forge).toEqual(["needed d1 github.com website"]);
      // A project kept on this Mac, or one that lives nowhere, needs none.
      at.repos.push(repo("notes", null, "d1"));
      at.setup.runsOnChanged(at.repos[1] as RepoView);
      return new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
        expect(at.forge).toEqual(["needed d1 github.com website"]);
      });
    });
  });

  it("takes a removed computer's cards with it", () => {
    const at = world();
    at.setup.joined(MINI, undefined, false);
    // A GitLab project set to run there raised its host's own card for it.
    at.repos.push(repo("api", "https://gitlab.com/acme/api.git", "d1"));
    const gitlabCard = "card-forge-gitlab.com-d1";
    at.stack.set(gitlabCard, { id: gitlabCard, title: "Sign in to GitLab on Mac mini" } as never);
    at.devices.length = 0;
    at.setup.devicesChanged();
    expect(at.stack.has(CARD)).toBe(false);
    expect(at.withdrawn).toContainEqual([CARD, "the computer was removed"]);
    expect(at.withdrawn).toContainEqual([gitlabCard, "the computer was removed"]);
  });
});
