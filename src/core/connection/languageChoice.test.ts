import { type PersonalExtensionView, personalSnapshotSchema } from "@shared/personal/manifest";
import {
  appearanceSchema,
  DEFAULT_SHELL_PREFERENCES,
  shellPreferencesSchema,
} from "@shared/preferences";
import { expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";

// The review of the language choice (`language-choice`, folded into major 16): a
// view on major 15 that does not name it reads the look strictly, so the
// captain's choice never reaches it, on a push or a read, and a view naming
// the change reads the whole look.
it("leaves the language choice out of the look an older view is pushed or answered", async () => {
  const look = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: { ...DEFAULT_SHELL_PREFERENCES.appearance, language: "ar" },
  };
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:shell:preferences") return look;
      if (channel === "inf:settings:appearance:get") return look.appearance;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const old = await connectClient(grant, { protocolVersion: "15.0.0", changes: [] });
  const current = await connectClient(grant, {
    protocolVersion: "15.0.0",
    changes: ["language-choice"],
  });
  const olderLook = shellPreferencesSchema.extend({
    appearance: appearanceSchema.omit({ language: true }),
  });
  const olderAppearance = appearanceSchema.omit({ language: true });
  expect(olderLook.parse(await old.invoke("inf:shell:preferences", []))).toEqual({
    ...look,
    appearance: DEFAULT_SHELL_PREFERENCES.appearance,
  });
  expect(olderAppearance.parse(await old.invoke("inf:settings:appearance:get", []))).toEqual(
    DEFAULT_SHELL_PREFERENCES.appearance,
  );
  expect(await current.invoke("inf:shell:preferences", [])).toEqual(look);
  expect(await current.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  at.events.emit("inf:shell:preferences", look);
  const pushed = await old.push((push) => push.channel === "inf:shell:preferences");
  expect(olderLook.parse(pushed.payload).appearance).not.toHaveProperty("language");
  expect((await current.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual(
    look,
  );
  await old.close();
  await current.close();
});

// The approved font plan (INF-3982, `font-choice`, folded into major 16): a view
// on major 15 that reads the language but not the fonts is never pushed or
// answered the fonts; one naming both, and every view from major 16 on, reads
// the whole look.
it("leaves the font choice out of the look a view without font-choice is pushed or answered", async () => {
  const look = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: {
      ...DEFAULT_SHELL_PREFERENCES.appearance,
      language: "ja",
      fonts: { app: "Inter", code: "ui-monospace" },
    },
  };
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:shell:preferences") return look;
      if (channel === "inf:settings:appearance:get") return look.appearance;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const older = await connectClient(grant, {
    protocolVersion: "15.0.0",
    changes: ["language-choice"],
  });
  const named = await connectClient(grant, {
    protocolVersion: "15.0.0",
    changes: ["language-choice", "font-choice"],
  });
  const current = await connectClient(grant, { changes: [] });
  const olderAppearance = appearanceSchema.omit({ fonts: true });
  const { fonts: _chosen, ...withoutFonts } = look.appearance;
  expect(olderAppearance.parse(await older.invoke("inf:settings:appearance:get", []))).toEqual(
    withoutFonts,
  );
  expect(await named.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  expect(await current.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  at.events.emit("inf:shell:preferences", look);
  const pushed = await older.push((push) => push.channel === "inf:shell:preferences");
  expect(olderAppearance.parse((pushed.payload as typeof look).appearance)).toEqual(withoutFonts);
  for (const view of [named, current])
    expect((await view.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual(
      look,
    );
  await older.close();
  await named.close();
  await current.close();
});

// The approved ambient music plan (INF-4741, `ambient-music`): a view whose
// hello does not list the change reads the look strictly, so it is never
// pushed or answered the music's switch and volume; one naming it reads the
// whole look.
it("leaves the ambient music out of the look a view without ambient-music is pushed or answered", async () => {
  const look = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: {
      ...DEFAULT_SHELL_PREFERENCES.appearance,
      ambientMusic: true,
      ambientPaused: true,
      ambientVolume: 55,
    },
  };
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:shell:preferences") return look;
      if (channel === "inf:settings:appearance:get") return look.appearance;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const older = await connectClient(grant, { changes: [] });
  const named = await connectClient(grant, { changes: ["ambient-music"] });
  const current = await connectClient(grant, { changes: ["ambient-music", "ambient-pause"] });
  const olderAppearance = appearanceSchema.omit({
    ambientMusic: true,
    ambientPaused: true,
    ambientVolume: true,
  });
  const { ambientPaused: _pause, ...withoutPause } = look.appearance;
  const { ambientMusic: _on, ambientVolume: _volume, ...withoutMusic } = withoutPause;
  expect(olderAppearance.parse(await older.invoke("inf:settings:appearance:get", []))).toEqual(
    withoutMusic,
  );
  expect(await named.invoke("inf:settings:appearance:get", [])).toEqual(withoutPause);
  expect(await current.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  at.events.emit("inf:shell:preferences", look);
  const pushed = await older.push((push) => push.channel === "inf:shell:preferences");
  expect(olderAppearance.parse((pushed.payload as typeof look).appearance)).toEqual(withoutMusic);
  expect((await named.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual({
    ...look,
    appearance: withoutPause,
  });
  await older.close();
  await named.close();
  await current.close();
});

// The ambient styles (INF-5056's kept choices, `ambient-style`): a view whose
// hello does not list the change is never pushed or answered the chosen
// style, which its stricter reading of the look would refuse; one naming it
// reads the whole look.
it("leaves the ambient style out of the look a view without ambient-style is pushed or answered", async () => {
  const look = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: {
      ...DEFAULT_SHELL_PREFERENCES.appearance,
      ambientMusic: true,
      ambientVolume: 55,
      ambientStyle: "harbor-dawn",
    },
  };
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:shell:preferences") return look;
      if (channel === "inf:settings:appearance:get") return look.appearance;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const older = await connectClient(grant, { changes: ["ambient-music", "ambient-pause"] });
  const current = await connectClient(grant, {
    changes: ["ambient-music", "ambient-pause", "ambient-style"],
  });
  const { ambientStyle: _style, ...withoutStyle } = look.appearance;
  expect(await older.invoke("inf:settings:appearance:get", [])).toEqual(withoutStyle);
  expect(await current.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  at.events.emit("inf:shell:preferences", look);
  expect((await older.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual({
    ...look,
    appearance: withoutStyle,
  });
  expect((await current.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual(
    look,
  );
  await older.close();
  await current.close();
});

// Keep playing while away (INF-5528's answer, `ambient-away`): a view whose
// hello does not list the change is never pushed or answered the choice,
// which its stricter reading of the look would refuse.
it("leaves keep playing while away out of the look a view without ambient-away is pushed or answered", async () => {
  const look = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: {
      ...DEFAULT_SHELL_PREFERENCES.appearance,
      ambientMusic: true,
      ambientVolume: 55,
      ambientPlaysWhenAway: true,
    },
  };
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:shell:preferences") return look;
      if (channel === "inf:settings:appearance:get") return look.appearance;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const older = await connectClient(grant, {
    changes: ["ambient-music", "ambient-pause", "ambient-style"],
  });
  const current = await connectClient(grant, {
    changes: ["ambient-music", "ambient-pause", "ambient-style", "ambient-away"],
  });
  const { ambientPlaysWhenAway: _plays, ...withoutAway } = look.appearance;
  expect(await older.invoke("inf:settings:appearance:get", [])).toEqual(withoutAway);
  expect(await current.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  at.events.emit("inf:shell:preferences", look);
  expect((await older.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual({
    ...look,
    appearance: withoutAway,
  });
  expect((await current.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual(
    look,
  );
  await older.close();
  await current.close();
});

// INF-5326's piece 4 review (`settings-current`): a view whose hello does not
// list the change reads a panel's reads as a closed list, so a panel that
// declares `settings.current` would make it refuse the whole panel list. Its
// home leaves those panels, and drafts, out of the list it answers and pushes;
// the other panels arrive, and a view naming the change reads every panel.
it("leaves the panels that read settings out of the panel list a view without settings-current is pushed or answered", async () => {
  const notes: PersonalExtensionView = {
    id: "notes",
    source: "yours",
    by: null,
    title: "Notes",
    placement: { x: "left", y: "top" },
    order: 100,
    size: "content",
    present: true,
    ownPresence: false,
    moves: false,
    running: false,
    reads: ["tasks.board"],
    sql: [],
    panel: null,
    frame: { version: "0".repeat(16) },
    server: null,
    cardViews: [],
    cards: {},
    header: [],
    commands: [],
    error: null,
  };
  const music: PersonalExtensionView = {
    ...notes,
    id: "music",
    title: "Music",
    reads: ["tasks.board", "settings.current"],
  };
  const panels = personalSnapshotSchema.parse({
    extensions: [notes, music],
    drafts: [{ ...music, id: "music-being-built", running: true }],
  });
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:plugins:personal:list") return panels;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const older = await connectClient(grant, { changes: ["ambient-music", "ambient-pause"] });
  const current = await connectClient(grant, { changes: ["settings-current"] });
  const withoutSettings = { extensions: [notes], drafts: [] };
  expect(await older.invoke("inf:plugins:personal:list", [])).toEqual(withoutSettings);
  expect(await current.invoke("inf:plugins:personal:list", [])).toEqual(panels);
  at.events.emit("inf:plugins:personal", panels);
  expect((await older.push((push) => push.channel === "inf:plugins:personal")).payload).toEqual(
    withoutSettings,
  );
  expect((await current.push((push) => push.channel === "inf:plugins:personal")).payload).toEqual(
    panels,
  );
  await older.close();
  await current.close();
});
