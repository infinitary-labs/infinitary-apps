import { ACTIONS } from "@shared/actions";
import type { Card } from "@shared/cards";
import { inLanguage } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { wordedCardText, wordSaidMarks } from "@shared/i18n/said";
import { remoteLoginWords } from "@shared/remoteLogin";
import { SECRETS_AREAS } from "@shared/secrets";
import { describe, expect, it, vi } from "vitest";
import { fakeClockEachTest, setup, tick } from "../../../tests/helpers/firstmateHarness";
import { asAView } from "../askedFromAView";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: hand-offs to Settings, which the host writes as one card each (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

describe("FirstmateAgent", () => {
  it("hands connecting and removing a device to Settings -> Devices as one card the host writes", async () => {
    const { agent, session, specs, supervisor } = setup();
    const devices = [{ id: "mac-1", kind: "view", name: "<b>Mini</b>", pairedAt: 1 }];
    const asked: string[] = [];
    agent.bindAppDispatch(async (channel) => {
      asked.push(channel);
      return (channel === "inf:devices:list" ? devices : true) as never;
    });
    await agent.converse("connect my MacBook Air");
    const tool = (name: string) => {
      const found = specs[0]?.tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`Missing ${name}`);
      return found;
    };
    const change = (action: string, value: unknown) =>
      tool("app_change").run({ action, value, evidence: "the captain asked" });

    expect((await change("device-invite", { name: "MacBook Air" })).text).toMatch(
      /^Settings button offered on /,
    );
    const connect = supervisor.cards
      .snapshot()
      .find((card) => card.title === "Connect your MacBook Air") as Card;
    expect(connect.body).toBe(
      "<p>Your first mate stays on this computer. Your MacBook Air will show it and can run work for it.</p>\n<p>Make a link here, then paste it into Infinitary on your MacBook Air.</p>\n<p>It works once, for ten minutes. Only your click can make it, so I never see it.</p>",
    );
    expect(connect.actions.find((action) => action.default)).toMatchObject({
      label: "Make a link",
      effect: { kind: "open", target: "devices", make: "link" },
    });
    expect(connect.actions.find((action) => !action.default)).toMatchObject({ label: "Not now" });
    expect(connect.actions.find((action) => !action.default)?.effect).toBeUndefined();
    expect(asked).not.toContain("inf:devices:invite");

    expect((await change("device-remove", { deviceId: "mac-1" })).text).toMatch(/offered on/);
    const remove = supervisor.cards
      .snapshot()
      .find((card) => card.title === "Remove <b>Mini</b>?") as Card;
    expect(remove.actions.find((action) => action.default)).toMatchObject({
      label: "Remove <b>Mini</b>",
      danger: true,
      effect: { kind: "open", target: "devices", remove: "mac-1" },
    });
    expect(asked).not.toContain("inf:devices:remove");

    const open = connect.actions.find((action) => action.default);
    expect(supervisor.cardActions.act(connect.id, open?.id ?? "")).toEqual({
      effect: { kind: "open", target: "devices", make: "link" },
    });
    session.emitTurnEnd("Offered.");
    session.resolveNextPrompt();
    await tick();
  });

  // INF-5355's review, share-checks-and-keep-card: an act Settings shows only on the first
  // mate's own computer keeps its card up when a paired window clicks it, an older one included.
  it("refuses a paired window's click on a card for the first mate's own computer, and keeps it up", async () => {
    const { agent, session, specs, supervisor } = setup();
    agent.bindAppDispatch(async () => true as never);
    await agent.converse("open my use history in Secrets");
    const tool = specs[0]?.tools.find((entry) => entry.name === "app_change");
    const area = SECRETS_AREAS[2];
    await tool?.run({ action: "secrets-page", value: { page: area.value }, evidence: "asked" });
    const card = supervisor.cards
      .snapshot()
      .find((shown) => shown.title === `Open ${area.label} in Secrets`) as Card;
    const open = card.actions.find((action) => action.default);
    expect(open?.effect).toMatchObject({ kind: "open", fromHome: true });

    expect(() =>
      asAView(() => supervisor.cardActions.act(card.id, open?.id ?? ""), { view: "air" }),
    ).toThrow(m.viewFromHomeOnlyThere());
    expect(supervisor.cards.snapshot().find((shown) => shown.id === card.id)?.status).toBe("ready");
    // The captain's click on the first mate's own computer opens it.
    expect(supervisor.cardActions.act(card.id, open?.id ?? "").effect).toMatchObject({
      kind: "open",
      section: "secrets",
      item: area.value,
    });
    session.emitTurnEnd("Offered.");
    session.resolveNextPrompt();
    await tick();
  });

  it("hands adding a computer that runs work by a command, and removing one, to Settings -> Devices", async () => {
    const { agent, session, specs, supervisor } = setup();
    const devices = [
      {
        id: "mini-1",
        kind: "work",
        name: "Mac mini",
        pairedAt: 1,
        user: "sam",
        onThisMac: false,
        inReach: true,
        tasks: 1,
        runs: ["website"],
      },
    ];
    const asked: string[] = [];
    agent.bindAppDispatch(async (channel) => {
      asked.push(channel);
      return (channel === "inf:devices:list" ? devices : true) as never;
    });
    await agent.converse("add my mini by a command");
    const app = specs[0]?.tools.find((entry) => entry.name === "app_change");
    if (!app) throw new Error("Missing app_change");
    const change = (action: string, value: unknown) =>
      app.run({ action, value, evidence: "the captain asked" });
    const card = (title: string) =>
      supervisor.cards.snapshot().find((entry) => entry.title === title) as Card;

    expect((await change("device-invite", { name: "Mac mini", how: "command" })).text).toMatch(
      /offered on/,
    );
    const command = card("Add your Mac mini by a command");
    expect(command.body).toBe(
      "<p>Make the command here, then run it once in Terminal on your Mac mini.</p>\n<p>It works once, for ten minutes, or thirty when it downloads Infinitary there. Only your click can make it, so I never see it.</p>",
    );
    expect(command.actions.find((action) => action.default)).toMatchObject({
      label: "Make the command",
      effect: { kind: "open", target: "devices", make: "command" },
    });

    expect((await change("device-invite", { how: "another-user" })).text).toMatch(/offered on/);
    const user = card("Run work as another user on this computer");
    expect(user.body).toBe(
      "<p>Its work then runs as that user, with sign-ins of its own, and cannot control your first mate.</p>\n<p>That user, like every user on this computer, can read files in your home folder, outside private folders such as Desktop and Documents.</p>\n<p>Make the user in System Settings first. Then make the command here, and run it once as that user.</p>",
    );
    expect(user.actions.find((action) => action.default)).toMatchObject({
      label: "Make the command",
      effect: { kind: "open", target: "devices", make: "user-command" },
    });
    // One card at a time: asking again revises it.
    expect(card("Add your Mac mini by a command")).toBeUndefined();
    expect(asked).not.toContain("inf:devices:invite");

    expect((await change("device-remove", { deviceId: "mini-1" })).text).toMatch(/offered on/);
    const remove = card("Remove Mac mini?");
    expect(remove.body).toBe(
      "<p>Its task on website stops, and its unmerged work comes to me first.</p>\n<p>Then I remove what I set up there, with its sign-ins. Only your click can remove it.</p>",
    );
    expect(remove.actions.find((action) => action.default)).toMatchObject({
      label: "Remove Mac mini",
      danger: true,
      effect: { kind: "open", target: "devices", remove: "mini-1" },
    });
    expect(asked).not.toContain("inf:devices:remove");
    session.emitTurnEnd("Offered.");
    session.resolveNextPrompt();
    await tick();
  });

  it("hands adding a Mac by its address, and updating Firstmate on any computer, to Settings -> Devices", async () => {
    const { agent, session, specs, supervisor } = setup();
    const devices = [
      {
        id: "mini-1",
        kind: "work",
        name: "Mac mini",
        pairedAt: 1,
        user: "sam",
        onThisMac: false,
        remoteLogin: "sam@mini.local",
      },
      { id: "air-1", kind: "work", name: "MacBook Air", pairedAt: 2, user: "sam" },
      // Added by a command, in reach on an older Firstmate that takes the update order.
      {
        id: "studio-1",
        kind: "work",
        name: "Mac Studio",
        pairedAt: 3,
        user: "sam",
        onThisMac: false,
        inReach: true,
        otherVersion: { app: "0.1.20", than: "older", takesWork: true, updateBy: "connection" },
      },
      // Another user on this Mac, on a Firstmate too old to take it.
      {
        id: "builder-1",
        kind: "work",
        name: "MacBook Pro",
        pairedAt: 4,
        user: "builder",
        onThisMac: true,
        inReach: false,
        otherVersion: { than: "older", takesWork: false, updateBy: "command" },
      },
      // In reach on this Mac's own version.
      {
        id: "same-1",
        kind: "work",
        name: "iMac",
        pairedAt: 5,
        user: "sam",
        onThisMac: false,
        inReach: true,
      },
    ];
    const asked: string[] = [];
    agent.bindAppDispatch(async (channel) => {
      asked.push(channel);
      return (channel === "inf:devices:list" ? devices : true) as never;
    });
    await agent.converse("add my mini at sam@mini.local");
    const app = specs[0]?.tools.find((entry) => entry.name === "app_change");
    if (!app) throw new Error("Missing app_change");
    const change = (action: string, value: unknown) =>
      app.run({ action, value, evidence: "the captain asked" });
    const card = (title: string) =>
      supervisor.cards.snapshot().find((entry) => entry.title === title) as Card;

    expect(
      (await change("device-invite", { how: "address", address: "sam@mini.local" })).text,
    ).toMatch(/offered on/);
    const add = card("Add the computer at sam@mini.local");
    // INF-6043's change 1: what the add makes, over SSH; a named account asks for none.
    const here = m.placeThisComputer();
    const words = (shown: Card) => (shown.body ?? "").split(/<[^>]+>/).filter((t) => t.trim());
    expect(words(add)).toEqual([
      m.devicesAddressCardResult({ address: "sam@mini.local", computer: here }),
      m.devicesAddressCardSetUp(),
      m.devicesAddressCardAsk(),
    ]);
    inLanguage("fr", () => {
      expect(wordSaidMarks(add.body ?? "")).toContain(`>${m.devicesAddressCardSetUp()}</p>`);
    });
    expect(add.actions.find((action) => action.default)).toMatchObject({
      label: "Add it",
      effect: { kind: "open", target: "devices", add: "sam@mini.local" },
    });
    expect(add.actions.find((action) => !action.default)).toMatchObject({ label: "Not now" });
    expect(
      (await change("device-invite", { how: "address", address: "-oProxyCommand=evil" })).text,
    ).not.toMatch(/offered on/);
    expect((await change("device-update", { deviceId: "mini-1" })).text).toMatch(/offered on/);
    const update = card("Update Infinitary on Mac mini");
    expect(update.body).toBe(
      `<p>${remoteLoginWords.updateDownloadOffer()}</p>\n<p>Its running work stops for a moment and goes on after.</p>`,
    );
    expect(update.actions.find((action) => action.default)).toMatchObject({
      label: "Update it",
      effect: { kind: "open", target: "devices", update: "mini-1" },
    });
    // Added any other way, it updates over the network while it is in reach.
    expect((await change("device-update", { deviceId: "studio-1" })).text).toMatch(/offered on/);
    const overNetwork = card("Update Infinitary on Mac Studio");
    expect(overNetwork.body).toBe(
      "<p>I send this computer's Infinitary to it over your network, and it starts again.</p>\n<p>Its running work stops for a moment and goes on after.</p>",
    );
    expect(overNetwork.actions.find((action) => action.default)).toMatchObject({
      label: "Update it",
      effect: { kind: "open", target: "devices", update: "studio-1" },
    });
    expect((await change("device-update", { deviceId: "builder-1" })).text).toMatch(/offered on/);
    const byCommand = card("Update Infinitary on Running as Builder");
    expect(byCommand.body).toBe(
      "<p>Its version of Infinitary is too old to update from here, so it needs a new command.</p>\n<p>Make the command here, then run it once in Terminal as Builder.</p>",
    );
    expect(byCommand.actions.find((action) => action.default)).toMatchObject({
      label: "Make the command",
      effect: { kind: "open", target: "devices", make: "user-command" },
    });
    // Out of reach, or on this Mac's version already, nothing is offered.
    expect((await change("device-update", { deviceId: "air-1" })).text).toContain(
      "cannot tell its version",
    );
    expect((await change("device-update", { deviceId: "same-1" })).text).toContain(
      "already runs this computer's version",
    );
    expect(asked).not.toContain("inf:devices:add");
    expect(asked).not.toContain("inf:devices:update");

    const open = add.actions.find((action) => action.default);
    expect(supervisor.cardActions.act(add.id, open?.id ?? "")).toEqual({
      effect: { kind: "open", target: "devices", add: "sam@mini.local" },
    });
    // A bare address, as in INF-6043's recording, asks for the account name.
    expect((await change("device-invite", { how: "address", address: "10.0.0.9" })).text).toMatch(
      /offered on/,
    );
    expect(words(card("Add the computer at 10.0.0.9"))).toEqual([
      m.devicesAddressCardResult({ address: "10.0.0.9", computer: here }),
      m.devicesAddressCardSetUp(),
      m.devicesAddressCardNoAccount({ computer: here }),
      m.devicesAddressCardAsk(),
    ]);
    // INF-4926's plan: how "address" with no address offers a card that opens the form.
    expect((await change("device-invite", { how: "address", name: "Mac mini" })).text).toMatch(
      /offered on/,
    );
    const form = card(m.devicesAddressFormTitleNamed({ device: "Mac mini" }));
    // The card keeps its words' facts, so a view in another language words it there.
    expect(wordSaidMarks(form.body ?? "")).toContain(
      `>${m.devicesAddressFormSetUp()}</p>\n<p data-inf-said=`,
    );
    expect(wordSaidMarks(form.body ?? "")).toContain(`>${m.devicesAddressFormOpen()}</p>`);
    expect(wordedCardText(form.title, form.body)).toBe(
      m.devicesAddressFormTitleNamed({ device: "Mac mini" }),
    );
    inLanguage("fr", () => {
      expect(wordSaidMarks(form.body ?? "")).toContain(`>${m.devicesAddressFormOpen()}</p>`);
      expect(wordedCardText(form.title, form.body)).toBe(
        m.devicesAddressFormTitleNamed({ device: "Mac mini" }),
      );
    });
    expect(form.actions.find((action) => action.default)).toMatchObject({
      label: m.devicesAddressFormOpenButton(),
      effect: { kind: "open", target: "devices", addressForm: true },
    });
    expect(form.actions.find((action) => !action.default)).toMatchObject({
      label: m.devicesAddressFormNotNow(),
    });
    const openForm = form.actions.find((action) => action.default);
    expect(supervisor.cardActions.act(form.id, openForm?.id ?? "")).toEqual({
      effect: { kind: "open", target: "devices", addressForm: true },
    });

    session.emitTurnEnd("Offered.");
    session.resolveNextPrompt();
    await tick();
  });

  // Intent: a bug - once the captain clicked Add it on one computer's card,
  // asking to add the next computer was refused under that card's fixed id.
  it("offers a new add card for the next computer once the captain answered the last one", async () => {
    const { agent, session, specs, supervisor } = setup();
    agent.bindAppDispatch(async (channel) => (channel === "inf:devices:list" ? [] : true) as never);
    await agent.converse("add my mini at sam@mini.local");
    const app = specs[0]?.tools.find((entry) => entry.name === "app_change");
    if (!app) throw new Error("Missing app_change");
    const add = (address: string) =>
      app.run({
        action: "device-invite",
        value: { how: "address", address },
        evidence: `add the computer at ${address}`,
      });
    const card = (title: string) =>
      supervisor.cards.snapshot().find((entry) => entry.title === title);
    const click = (shown: Card | undefined) =>
      supervisor.cardActions.act(
        shown?.id ?? "",
        shown?.actions.find((action) => action.default)?.id ?? "",
      );

    expect((await add("sam@mini.local")).text).toMatch(/^Settings button offered on /);
    const mini = card("Add the computer at sam@mini.local");
    expect(click(mini)).toEqual({
      effect: { kind: "open", target: "devices", add: "sam@mini.local" },
    });

    expect((await add("sam@studio.local")).text).toMatch(/^Settings button offered on /);
    const studio = card("Add the computer at sam@studio.local");
    expect(studio?.id).not.toBe(mini?.id);
    // While it is up, asking again revises it: one add card at a time.
    expect((await add("sam@imac.local")).text).toMatch(/^Settings button offered on /);
    expect(card("Add the computer at sam@studio.local")).toBeUndefined();
    const imac = card("Add the computer at sam@imac.local");
    expect(imac?.id).toBe(studio?.id);
    expect(click(imac)).toEqual({
      effect: { kind: "open", target: "devices", add: "sam@imac.local" },
    });

    expect((await add("sam@mini.local")).text).toMatch(/^Settings button offered on /);
    const again = card("Add the computer at sam@mini.local");
    expect([mini?.id, imac?.id]).not.toContain(again?.id);
    expect(supervisor.cardActions.act(again?.id ?? "", "not-now")).toBeDefined();
    expect((await add("sam@mini.local")).text).toMatch(/^Settings button offered on /);
    expect([mini?.id, imac?.id, again?.id]).not.toContain(
      card("Add the computer at sam@mini.local")?.id,
    );
    session.emitTurnEnd("Offered.");
    session.resolveNextPrompt();
    await tick();
  });

  it("hands signing a computer in to its own subscription to Settings -> Intelligence as one card the host writes", async () => {
    const { agent, session, specs, supervisor } = setup();
    const computers = [
      {
        deviceId: "mini-1",
        name: "Mac mini",
        onThisMac: false,
        reach: "in-reach",
        signIns: { providers: [], accounts: [], quota: null },
      },
      {
        deviceId: "builder-1",
        name: "This computer",
        user: "builder",
        onThisMac: true,
        reach: "in-reach",
        signIns: { providers: [], accounts: [], quota: null },
      },
      {
        deviceId: "air-1",
        name: "MacBook Air",
        onThisMac: false,
        controlling: true,
        reach: "out-of-reach",
        workSetup: { state: "blocked", reason: "background-off" },
        signIns: null,
      },
    ];
    const signInAction = ACTIONS["device-sign-in"];
    const air = computers.find((computer) => computer.deviceId === "air-1");
    if (!air) throw new Error("Missing work setup fixture");
    inLanguage("fr", () => {
      expect(JSON.stringify(signInAction.readValue([air]))).toContain(
        "is not allowed to run in the background",
      );
      const unanswered = { ...air, reach: "in-reach", workSetup: undefined, unanswered: true };
      expect(JSON.stringify(signInAction.readValue([unanswered]))).toContain(
        '"signInsUnanswered":true',
      );
      expect(() =>
        signInAction.offer?.({ deviceId: air.deviceId, provider: "openai-codex" }, [unanswered], {
          platform: "darwin",
        }),
      ).toThrow("did not say what it is signed in to");
    });
    const asked: string[] = [];
    agent.bindAppDispatch(async (channel) => {
      asked.push(channel);
      if (channel === "inf:devices:sign-ins") return computers as never;
      if (channel === "inf:accounts:list") return [] as never;
      if (channel === "inf:settings:decisions") return { settings: {} } as never;
      return true as never;
    });
    await agent.converse("sign in to codex on the mini");
    const change = (value: unknown) => {
      const found = specs[0]?.tools.find((entry) => entry.name === "app_change");
      if (!found) throw new Error("Missing app_change");
      return found.run({
        action: "device-sign-in",
        value,
        evidence: "sign in to codex on the mini",
      });
    };

    expect((await change({ deviceId: "mini-1", provider: "openai-codex" })).text).toMatch(
      /^Settings button offered on /,
    );
    const card = supervisor.cards
      .snapshot()
      .find((entry) => entry.title === "Sign in to Codex on Mac mini") as Card;
    expect(card.body).toBe(
      "<p>Mac mini signs in to Codex with a sign-in of its own. Nothing from this computer's sign-in goes there.</p>\n<p>Sign in opens Settings, where it starts under Mac mini.</p>",
    );
    expect(card.actions.find((action) => action.default)).toMatchObject({
      label: "Sign in",
      effect: {
        kind: "open",
        target: "subscriptions",
        signInOn: { deviceId: "mini-1", providerId: "openai-codex" },
      },
    });
    expect(card.actions.find((action) => !action.default)).toMatchObject({ label: "Not now" });
    // Another macOS user on this Mac is named by that user.
    await change({ deviceId: "builder-1", provider: "openrouter" });
    expect(supervisor.cards.snapshot().map((entry) => entry.title)).toContain(
      "Sign in to OpenRouter as Builder",
    );
    const state = specs[0]?.tools.find((entry) => entry.name === "app_state");
    if (!state) throw new Error("Missing app_state");
    const facts = JSON.stringify(JSON.parse((await state.run({ area: "intelligence" })).text));
    expect(facts).toContain('"windowConnected":true');
    expect(facts).toContain('"reach":"out-of-reach"');
    expect(facts).toContain('"reason":"background-off"');
    expect(facts).toContain('"reportedSignIns":false');
    expect((await change({ deviceId: "air-1", provider: "openai-codex" })).text).toContain(
      "MacBook Air is not connected for work, so no sign-in was offered.",
    );
    expect(supervisor.cards.snapshot().map((entry) => entry.title)).not.toContain(
      "Sign in to Codex on MacBook Air",
    );
    expect(asked).not.toContain("inf:devices:sign-in");
    expect((await change({ deviceId: "gone", provider: "xai" })).text).toBe(
      "No computer that runs work has that deviceId. Look with app_state.",
    );

    const open = card.actions.find((action) => action.default);
    expect(supervisor.cardActions.act(card.id, open?.id ?? "")).toEqual({
      effect: {
        kind: "open",
        target: "subscriptions",
        signInOn: { deviceId: "mini-1", providerId: "openai-codex" },
      },
    });
    session.emitTurnEnd("Offered.");
    session.resolveNextPrompt();
    await tick();
  });
});
