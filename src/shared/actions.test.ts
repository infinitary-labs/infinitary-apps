import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACTION_EXCEPTIONS,
  ACTION_FIELD_EXCEPTIONS,
  EXCEPTION_GROUNDS,
  groundlessExcuses,
  HOST_ACTION_EXCEPTIONS,
  settingFields,
  unaccountedChanges,
  uncoveredSettings,
} from "./actionCoverage";
import { ACTION_NAMES, ACTIONS, actionRefusal } from "./actions";
import { deviceUpdateBody, sourceMatchCard } from "./deviceUpdateNudge";
import * as m from "./i18n/messages.generated.ts";
import {
  CORE_INVOKE_CHANNELS,
  type CoreInvokeChannel,
  HOST_INVOKE_CHANNELS,
  invokeContract,
} from "./ipc";
import { remoteLoginWords } from "./remoteLogin";
import { secretActionSchema } from "./secrets";

// The action inventory checks these request schemas through ipc's channel groups.
// Literal project-relative paths declare indirect coverage to directUnitReach;
// channel definitions themselves already have explicit contract edges there.
const inventoryFiles = [
  "src/shared/appearanceActions.ts",
  "src/shared/decisions.ts",
  "src/shared/preferences.ts",
  "src/shared/quota.ts",
  "src/shared/settingsActs.ts",
  "src/shared/sharing.ts",
  "src/shared/update.ts",
] as const;
// The selector reads this declaration statically, never by importing a test.
void inventoryFiles;

describe("action permissions and channel parity", () => {
  // The review of INF-4926's plan: a Windows PC's first mate adds no computer by its address, so
  // the address way's card there makes a link, while a Mac's opens the address form.
  it("offers a link for the address way where the first mate's computer is a Windows PC", () => {
    const invite = ACTIONS["device-invite"];
    expect(invite.offer?.({ how: "address" }, [], { platform: "darwin" })).toMatchObject({
      arrival: { addressForm: true },
    });
    expect(invite.offer?.({ how: "address" }, [], { platform: "win32" })).toMatchObject({
      arrival: { make: "link" },
    });
    expect(
      invite.offer?.({ how: "address", address: "sam@mini.local" }, [], { platform: "win32" }),
    ).toMatchObject({ arrival: { make: "link" } });
    // The line the first mate reads recommends what its card there carries out: the address on a
    // Mac, the link on a Windows PC.
    expect(invite.lineOn?.("darwin")).toBe(invite.line);
    expect(invite.line).toContain("recommending the address");
    expect(invite.lineOn?.("win32")).toContain("recommending a link");
    expect(invite.lineOn?.("win32")).not.toContain("recommending the address");
  });

  // INF-3116, answer A: the first mate only offers the app's Allow card for
  // a private site; the captain's click on it adds the checked name.
  it("offers a private site on the app's Allow card, checked, and never one already listed", () => {
    const allow = ACTIONS["private-site-allow"];
    expect(allow.tier).toBe("hands");
    const view = { available: true, sites: ["wiki.corp.example"] };
    expect(
      allow.offer?.({ site: "*.Corp.Example.com" }, view, { platform: "darwin" }),
    ).toMatchObject({
      title: "Let task browsers reach sites under .corp.example.com?",
      label: "Allow",
      arrival: { privateSite: ".corp.example.com" },
    });
    expect(() => allow.offer?.({ site: ".com" }, view, { platform: "darwin" })).toThrow(
      "two or more parts",
    );
    expect(() => allow.offer?.({ site: "10.20.30.40" }, view, { platform: "darwin" })).toThrow(
      "never by its address",
    );
    expect(() =>
      allow.offer?.({ site: "wiki.corp.example" }, view, { platform: "darwin" }),
    ).toThrow("already on the private sites list");
  });

  it("INF-1007: integration-add carries each named server kind into its sign-in form", () => {
    const add = ACTIONS["integration-add"];
    const view = {
      integrations: [],
      addable: [
        { kind: "gitlab", name: "GitLab" },
        { kind: "github-enterprise", name: "GitHub Enterprise" },
        { kind: "google", name: "Google" },
      ],
    };
    for (const kind of ["gitlab", "github-enterprise"]) {
      const value = { kind, host: "code.example.com" };
      expect(add.value.parse(value)).toEqual(value);
      expect(add.offer?.(value, view, { platform: "darwin" })).toMatchObject({
        arrival: { signIn: `${kind}:code.example.com` },
        label: "Open Integrations",
      });
    }
    expect(() =>
      add.offer?.({ kind: "google", host: "code.example.com" }, view, { platform: "darwin" }),
    ).toThrow("host is used only");
  });
  it("INF-5348: integration-add for the inbox opens the Infinitary command's switch, never a server key form", () => {
    const add = ACTIONS["integration-add"];
    const view = { integrations: [], addable: [] };
    const offer = add.offer?.({ kind: "inbox" }, view, { platform: "darwin" });
    expect(offer).toMatchObject({
      label: "Open Integrations",
      arrival: { section: "integrations", item: "inbox" },
    });
    expect(offer?.arrival).not.toHaveProperty("signIn");
  });
  it("changes an OpenRouter decision pick without creating outbound consent", () => {
    const answerer = { kind: "openrouter" as const, model: "jaredpalmer/kev-4b" };
    const current = {
      settings: { version: 1, answerer: { kind: "adapted", offering: "auto" }, egress: {} },
      stateVersion: 1,
      natives: [],
    };
    expect(ACTIONS["decision-model"].toRequest({ answerer }, current, (path) => path)).toEqual([
      { ...current.settings, answerer },
    ]);
    expect(ACTIONS["decision-model"].done({ answerer })).toBe(
      "decision model OpenRouter · jaredpalmer/kev-4b",
    );
  });
  it("sets or clears reasoning for one offering and served level through the catalog", () => {
    const action = ACTIONS["crew-reasoning"];
    const choice = { key: "xai/grok-4", slot: "high" as const, level: "high" as const };
    expect(action.value.parse(choice)).toEqual(choice);
    expect(action.toRequest(choice, undefined, (path) => path)).toEqual([
      choice.key,
      "high",
      "high",
    ]);
    expect(action.toRequest({ ...choice, level: null }, undefined, (path) => path)).toEqual([
      choice.key,
      "high",
      null,
    ]);
    expect(action.done(choice)).toBe("xai/grok-4 at high: High");
    expect(action.done({ ...choice, level: null })).toBe("xai/grok-4 at high: Use level default");
    expect(action.value.safeParse({ ...choice, level: "max" }).success).toBe(false);
  });
  it("projects the current default wash when a saved appearance predates that field", () => {
    expect(ACTIONS["window-wash"].readValue({ theme: "dark", showCrewModelNames: true })).toEqual({
      strength: 0,
    });
  });
  it("reads an appearance saved before the size control as 100%, and changes size alone", () => {
    const saved = { theme: "light" as const, washStrength: 37, showCrewModelNames: false };
    expect(ACTIONS["window-size"].readValue(saved)).toEqual({ size: 100 });
    expect(ACTIONS["window-size"].toRequest({ size: 125 }, saved, (path) => path)).toEqual([
      { ...saved, size: 125 },
    ]);
    expect(ACTIONS["window-size"].done({ size: 125 })).toBe("window size 125%");
    expect(ACTIONS["window-size"].value.safeParse({ size: 120 }).success).toBe(false);
  });
  it("changes personal resources only when asked, and maps the saved switch both ways", () => {
    const action = ACTIONS["personal-resources"];
    expect(action.tier).toBe("asked");
    expect(action.area).toBe("intelligence");
    expect(action.change).toBe("inf:settings:personal-resources:set");
    expect(action.current).toBe("inf:settings:personal-resources:get");
    for (const enabled of [true, false]) {
      const value = { enabled };
      expect(action.value.parse(value)).toEqual(value);
      expect(action.toRequest(value, !enabled, (path) => path)).toEqual([enabled]);
      expect(action.readValue(enabled)).toEqual(value);
      expect(action.done(value)).toBe(`global instructions and skills ${enabled ? "on" : "off"}`);
    }
    expect(action.value.safeParse({ enabled: "yes" }).success).toBe(false);
  });
  it("composes the accepted notification trail wording", () => {
    expect(ACTIONS.notifications.done({ enabled: false })).toBe("notifications off");
    expect(ACTIONS.notifications.done({ enabled: true })).toBe("notifications on");
  });
  it("composes migrated theme and panel trail wording", () => {
    expect(ACTIONS.theme.done({ theme: "light" })).toBe("switched to the light theme");
    expect(ACTIONS.panel.done({ surface: "Tasks", description: "hidden" })).toBe("Tasks hidden");
    expect(
      ACTIONS.panel.done({
        surface: "Activity",
        description: "moved to the right rail, top; hidden",
      }),
    ).toBe("Activity moved to the right rail, top; hidden");
  });
  // INF-5354: Settings → Intelligence's Restore, as the first mate asks it. The
  // saved pins come only from the Off choice's migration (migrateAlwaysRoute),
  // which keeps the routing row in this shape.
  it("restores the saved model pins after the current ones, once each, and clears them", () => {
    const kept = { provider: "codex", id: "gpt-5.5" };
    const saved = { provider: "claude", id: "claude-opus-5-5" };
    const migrated = { dynamicRouting: true, pins: [kept], dormantPins: [saved, kept] };
    expect(ACTIONS["model-pins"].toRequest({ restore: true }, migrated, (path) => path)).toEqual([
      { dynamicRouting: true, pins: [kept, saved], dormantPins: [] },
    ]);
    expect(() =>
      ACTIONS["model-pins"].toRequest(
        { restore: true },
        { ...migrated, dormantPins: [] },
        (path) => path,
      ),
    ).toThrow("No saved pins to restore.");
  });
  // INF-5350 and INF-5339: what app_state reads of each line is only what its
  // action needs, never the Diagnostics install ID, a live sign-in code, the
  // login at a computer's address or what an MCP server runs.
  it("hands the first mate none of the captain's private values in any line's state", () => {
    const installId = "3f8e2a6c-9b1d-4e7f-a2c5-6d0b9e4f1a37";
    const userCode = "WDJB-MJHT";
    const login = "sam@mini.local";
    const runs = "npx -y @acme/notes-server --token-file /Users/sam/.notes-token";
    const views: Partial<Record<CoreInvokeChannel, unknown>> = {
      "inf:settings:sharing:get": {
        diagnostics: { enabled: true, installId, milestones: [], pending: [] },
        contribution: { enabled: false },
        termsPublished: false,
        termsVersion: "1",
        diagnosticsDestination: null,
        askPending: false,
      },
      "inf:forges:list": {
        signIns: [
          {
            host: "github.com",
            name: "GitHub",
            login: "sam-codes",
            state: "ok",
            projects: 3,
            since: 1,
          },
        ],
        hosts: [],
        flow: {
          host: "github.com",
          userCode,
          verificationUri: "https://github.com/login/device",
          expiresAt: 2,
        },
        ended: null,
      },
      "inf:devices:list": [
        { id: "mini", kind: "mac", name: "Mac mini", remoteLogin: login, inReach: true },
      ],
      "inf:integrations:list": {
        integrations: [
          {
            id: "notes",
            kind: "mcp",
            name: "Notes",
            account: null,
            health: "ok",
            paused: false,
            runs,
            actions: [],
          },
        ],
      },
    };
    for (const name of ACTION_NAMES) {
      const view = ACTIONS[name].current && views[ACTIONS[name].current as CoreInvokeChannel];
      if (view === undefined || view === null) continue;
      const read = JSON.stringify(ACTIONS[name].readValue(view));
      for (const secret of [installId, userCode, login, runs])
        expect(read, `${name} reads ${secret}`).not.toContain(secret);
    }
  });
  it("accounts for every changing core channel, with no stale inventory entries", () => {
    const changing = CORE_INVOKE_CHANNELS.filter(
      (channel) => invokeContract[channel].effect === "change",
    );
    const covered = new Set(
      ACTION_NAMES.flatMap((name) => [ACTIONS[name].change, ...(ACTIONS[name].channels ?? [])]),
    );
    expect(unaccountedChanges(changing, covered as Set<string>, ACTION_EXCEPTIONS)).toEqual([]);
  });
  it("accounts for each setting inside a shared request, with no stale field claims", () => {
    for (const channel of CORE_INVOKE_CHANNELS) {
      const lines = ACTION_NAMES.map((name) => ACTIONS[name]).filter(
        (line) => line.change === channel,
      );
      if (!lines.length) continue;
      // Every field of a claimed object or selector request, even one line's (INF-5354).
      const fields = settingFields(invokeContract[channel].request);
      // A request's one line that names no fields owns the whole request.
      const whole = lines.length === 1 && !lines[0]?.fields;
      if (whole) {
        expect(ACTION_FIELD_EXCEPTIONS[channel], channel).toBeUndefined();
        continue;
      }
      const claimed = lines.flatMap((line) => line.fields ?? []);
      const exceptions = ACTION_FIELD_EXCEPTIONS[channel] ?? {};
      if (!fields.length) {
        expect(claimed, channel).toEqual([]);
        continue;
      }
      expect(uncoveredSettings(fields, claimed, exceptions), channel).toEqual([]);
      for (const field of claimed) expect(fields, `${channel}.${field}`).toContain(field);
      for (const [field, [ground, why]] of Object.entries(exceptions)) {
        expect(fields, channel).toContain(field);
        expect(claimed, channel).not.toContain(field);
        expect(EXCEPTION_GROUNDS, `${channel}.${field}`).toContain(ground);
        expect(why.trim()).not.toBe("");
      }
    }
    for (const channel of Object.keys(ACTION_FIELD_EXCEPTIONS))
      expect(
        ACTION_NAMES.some((name) => ACTIONS[name].change === channel),
        channel,
      ).toBe(true);
  });
  it("accounts for every changing request the window's own program answers", () => {
    const changing = HOST_INVOKE_CHANNELS.filter(
      (channel) => invokeContract[channel].effect === "change",
    );
    // A window's own request a line claims, such as the key reminder, the first mate asks of that window.
    const claimed = new Set<string>(ACTION_NAMES.map((name) => ACTIONS[name].change ?? ""));
    expect(unaccountedChanges(changing, claimed, HOST_ACTION_EXCEPTIONS)).toEqual([]);
    // A new window request that changes something is refused until it has its ground.
    expect(
      unaccountedChanges([...changing, "inf:window:uncatalogued"], claimed, HOST_ACTION_EXCEPTIONS),
    ).toEqual(["inf:window:uncatalogued"]);
  });
  it("names each excuse's ground from the closed set", () => {
    const fields = Object.values(ACTION_FIELD_EXCEPTIONS).flatMap((each) =>
      Object.entries(each ?? {}),
    );
    expect(groundlessExcuses({ ...ACTION_EXCEPTIONS, ...HOST_ACTION_EXCEPTIONS })).toEqual([]);
    expect(groundlessExcuses(Object.fromEntries(fields))).toEqual([]);
    // "The captain's click" alone is no ground (INF-5354).
    expect(
      groundlessExcuses({
        "inf:app:quit": ["the captain's click", "Ends the window's program"],
        "inf:app:start-here": ["destructive", " "],
      }),
    ).toEqual(["inf:app:quit", "inf:app:start-here"]);
  });
  it("rejects a new setting in every shared object channel until catalogued or named as an exception", () => {
    for (const channel of [
      "inf:settings:appearance:set",
      "inf:settings:layout:set",
      "inf:presence:set",
      "inf:settings:routing:set",
      "inf:settings:decisions:set",
    ] as const) {
      const request = invokeContract[channel].request;
      const extended = request.def.items[0].extend({ uncatalogued: z.boolean() });
      const fields = settingFields(z.tuple([extended]));
      const claimed = ACTION_NAMES.filter((name) => ACTIONS[name].change === channel).flatMap(
        (name) => ACTIONS[name].fields ?? [],
      );
      const exceptions = ACTION_FIELD_EXCEPTIONS[channel];
      expect(uncoveredSettings(fields, claimed, exceptions), channel).toEqual(["uncatalogued"]);
      expect(uncoveredSettings(fields, [...claimed, "uncatalogued"], exceptions)).toEqual([]);
      expect(
        uncoveredSettings(fields, claimed, {
          ...exceptions,
          uncatalogued: ["consent", "Explicit captain-only control"],
        }),
      ).toEqual([]);
    }
  });
  it("refuses a new variant of a claimed union request until it has a line or a ground", () => {
    const channel = "inf:secrets:action";
    const claimed = ACTIONS["secret-end-read"].fields ?? [];
    const exceptions = ACTION_FIELD_EXCEPTIONS[channel];
    const extended = z.discriminatedUnion("kind", [
      ...secretActionSchema.options,
      z.strictObject({ kind: z.literal("uncatalogued"), what: z.string() }),
    ]);
    expect(uncoveredSettings(settingFields(z.tuple([extended])), claimed, exceptions)).toEqual([
      "what",
      "kind=uncatalogued",
    ]);
  });
  it("rejects an uncatalogued sharing choice on the existing selector channel", () => {
    const selector = invokeContract["inf:settings:sharing:set"].request.def.items[0];
    const request = z.tuple([z.enum([...selector.options, "uncatalogued"]), z.boolean()]);
    const claimed = ACTION_NAMES.filter(
      (name) => ACTIONS[name].change === "inf:settings:sharing:set",
    ).flatMap((name) => ACTIONS[name].fields ?? []);
    expect(uncoveredSettings(settingFields(request), claimed)).toEqual(["uncatalogued"]);
  });
  // INF-751, on the captain's ask to fix the rigidness: his choice relayed in
  // a crewmate's report, or his message sent while a turn runs, reaches the
  // first mate at a wake his own words did not begin, and still applies.
  // INF-752: a judgment line is the first mate's at any wake too, on the
  // reason it gives. Pausing, resuming and deleting a schedule are its
  // judgment, as making one is (docs/automation.md, "Drafts"); turning a
  // draft on is asked. Keeping the captain's directions is its judgment
  // too (INF-638).
  it("takes asked, own-words and judgment lines at any wake with evidence, never the captain's own", () => {
    for (const name of ACTION_NAMES) {
      const line = ACTIONS[name];
      expect(actionRefusal(line, { kind: "captain" })).toBeNull();
      for (const wake of ["captain", "captain-choice", "scheduled", "other"] as const) {
        expect(!!actionRefusal(line, { kind: "firstmate", wake, evidence: "asked" })).toBe(
          line.tier === "hands" || line.tier === "yours",
        );
        expect(actionRefusal(line, { kind: "firstmate", wake })).toBeTruthy();
      }
    }
    expect(ACTION_NAMES.filter((name) => ACTIONS[name].tier === "judgment")).toEqual([
      "direction",
      // The captain's word on INF-4421: a held batch's Try again needs no word of theirs.
      "project-batch-answer",
      "automation-state",
      "automation-pause-all",
      "automation-delete",
    ]);
    expect(ACTIONS["automation-edit"].tier).toBe("asked");
  });
});

// INF-333 F3/F4: the offered operation must describe the selected delivery path.
it("offers counted downloads for another Mac and the local copy for another user here", () => {
  const device = {
    id: "mini",
    kind: "work" as const,
    name: "Mac mini",
    pairedAt: 1,
    remoteLogin: "sam@mini.local",
  };
  const makeOffer = ACTIONS["device-update"].offer;
  if (!makeOffer) throw new Error("No update offer.");
  const offer = makeOffer({ deviceId: device.id }, [device], { platform: "darwin" });
  expect(offer.paragraphs[0]).toBe(remoteLoginWords.updateDownloadOffer());
  expect(offer.arrival).toEqual({ update: device.id });
  const here = makeOffer(
    { deviceId: device.id },
    [{ ...device, onThisMac: true, user: "builder" }],
    { platform: "darwin" },
  );
  expect(here.paragraphs[0]).toBe(remoteLoginWords.updateLocalCopyOffer());
  expect(here.paragraphs[0]).toBe(
    "This computer copies its own Infinitary there over Remote Login, with your own SSH key, and starts it again.",
  );
  expect(here.arrival).toEqual({ update: device.id });
  const nudge = deviceUpdateBody({
    ...device,
    deviceId: device.id,
    onThisMac: true,
    user: "builder",
    other: { app: "0.0.1", than: "older", takesWork: true, updateBy: "remote-login" },
  });
  expect(nudge).toContain(remoteLoginWords.updateLocalCopyOffer());
});

// INF-5635's plan, piece 3: Match sends a Mac the home's commit to build, asking once first;
// the first mate's offer words it as the app's own card does, and refuses a computer that is not a Mac.
it("words a source target as the app's own card, and refuses it for a computer that is not a Mac", () => {
  const commit = "c".repeat(40);
  const device = {
    id: "mini",
    kind: "work" as const,
    name: "Mac mini",
    pairedAt: 1,
    system: "macos" as const,
    inReach: true,
    otherVersion: { app: "0.0.1", takesWork: true, updateBy: "connection", source: { commit } },
  } as const;
  const makeOffer = ACTIONS["device-update"].offer;
  if (!makeOffer) throw new Error("No update offer.");
  const offer = makeOffer({ deviceId: device.id }, [device], { platform: "darwin" });
  const card = sourceMatchCard({ deviceId: device.id, device: "Mac mini", commit });
  expect(offer.title).toBe(card.title);
  for (const paragraph of offer.paragraphs.slice(0, 3))
    expect(card.body).toContain(`<p>${paragraph}</p>`);
  expect(offer.label).toBe(card.actions[0]?.label);
  expect(offer.arrival).toEqual({ update: device.id });
  expect(() =>
    makeOffer({ deviceId: device.id }, [{ ...device, system: "linux" }], { platform: "darwin" }),
  ).toThrow(m.devicesSourceNotMac({ device: "Mac mini" }));
});

// INF-322 direction B: a Mac a command added downloads over its own connection, or is sent this computer's copy.
it("offers a counted download to a Mac a command added that takes it, and the send to one that does not", () => {
  const device = {
    id: "mini",
    kind: "work" as const,
    name: "Mac mini",
    pairedAt: 1,
    system: "macos" as const,
    inReach: true,
  };
  const makeOffer = ACTIONS["device-update"].offer;
  if (!makeOffer) throw new Error("No update offer.");
  const other = { app: "0.0.1", than: "older", takesWork: true, updateBy: "connection" } as const;
  const downloads = makeOffer(
    { deviceId: device.id },
    [{ ...device, otherVersion: { ...other, downloads: true } }],
    { platform: "darwin" },
  );
  expect(downloads.paragraphs[0]).toBe(remoteLoginWords.updateConnectionDownloadOffer());
  expect(
    deviceUpdateBody({ ...device, deviceId: device.id, other: { ...other, downloads: true } }),
  ).toContain(remoteLoginWords.updateConnectionDownloadOffer());
  const sends = makeOffer({ deviceId: device.id }, [{ ...device, otherVersion: other }], {
    platform: "darwin",
  });
  expect(sends.paragraphs[0]).toBe(
    "I send this computer's Infinitary to it over your network, and it starts again.",
  );
  expect(deviceUpdateBody({ ...device, deviceId: device.id, other })).not.toContain(
    remoteLoginWords.updateConnectionDownloadOffer(),
  );
});
