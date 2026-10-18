import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACTION_EXCEPTIONS,
  ACTION_FIELD_EXCEPTIONS,
  settingFields,
  uncoveredSettings,
} from "./actionCoverage";
import { ACTION_NAMES, ACTIONS, actionRefusal } from "./actions";
import { deviceUpdateBody } from "./deviceUpdateNudge";
import { CORE_INVOKE_CHANNELS, type CoreInvokeChannel, invokeContract } from "./ipc";
import { remoteLoginWords } from "./remoteLogin";

describe("action permissions and channel parity", () => {
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
  it("accounts for every changing core channel, with no stale inventory entries", () => {
    const changing = CORE_INVOKE_CHANNELS.filter(
      (channel) => invokeContract[channel].effect === "change",
    );
    const covered = new Set(
      ACTION_NAMES.flatMap((name) => [ACTIONS[name].change, ...(ACTIONS[name].channels ?? [])]),
    );
    for (const channel of changing)
      expect(
        covered.has(channel as CoreInvokeChannel) || ACTION_EXCEPTIONS[channel],
        channel,
      ).toBeTruthy();
    for (const channel of Object.keys(ACTION_EXCEPTIONS)) {
      expect(changing).toContain(channel);
      expect(covered.has(channel as CoreInvokeChannel)).toBe(false);
    }
  });
  it("accounts for each setting inside a shared request, with no stale field claims", () => {
    for (const channel of CORE_INVOKE_CHANNELS) {
      const lines = ACTION_NAMES.map((name) => ACTIONS[name]).filter(
        (line) => line.change === channel,
      );
      if (lines.length < 2 && !lines.some((line) => line.fields)) continue;
      const fields = settingFields(invokeContract[channel].request);
      const claimed = lines.flatMap((line) => line.fields ?? []);
      const exceptions = ACTION_FIELD_EXCEPTIONS[channel] ?? {};
      expect(fields.length, channel).toBeGreaterThan(0);
      expect(uncoveredSettings(fields, claimed, exceptions), channel).toEqual([]);
      for (const field of claimed) expect(fields, `${channel}.${field}`).toContain(field);
      for (const [field, reason] of Object.entries(exceptions)) {
        expect(fields, channel).toContain(field);
        expect(claimed, channel).not.toContain(field);
        expect(reason.trim()).not.toBe("");
      }
    }
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
          uncatalogued: "Explicit captain-only control",
        }),
      ).toEqual([]);
    }
  });
  it("rejects an uncatalogued sharing choice on the existing selector channel", () => {
    const selector = invokeContract["inf:settings:sharing:set"].request.def.items[0];
    const request = z.tuple([z.enum([...selector.options, "uncatalogued"]), z.boolean()]);
    const claimed = ACTION_NAMES.filter(
      (name) => ACTIONS[name].change === "inf:settings:sharing:set",
    ).flatMap((name) => ACTIONS[name].fields ?? []);
    expect(uncoveredSettings(settingFields(request), claimed)).toEqual(["uncatalogued"]);
  });
  it("allows messages and schedules, refuses reports, and reserves the folder for own words", () => {
    for (const name of ACTION_NAMES) {
      const line = ACTIONS[name];
      expect(actionRefusal(line, { kind: "captain" })).toBeNull();
      expect(!!actionRefusal(line, { kind: "firstmate", wake: "captain", evidence: "asked" })).toBe(
        line.tier === "hands" || line.tier === "yours",
      );
      expect(
        actionRefusal(line, { kind: "firstmate", wake: "other", evidence: "asked" }),
      ).toBeTruthy();
      expect(
        !!actionRefusal(line, { kind: "firstmate", wake: "scheduled", evidence: "asked" }),
      ).toBe(line.tier !== "asked");
      expect(
        !!actionRefusal(line, { kind: "firstmate", wake: "captain-choice", evidence: "clicked" }),
      ).toBe(line.tier !== "asked");
      expect(actionRefusal(line, { kind: "firstmate", wake: "captain" })).toBeTruthy();
    }
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
