import {
  appearanceSchema,
  DEFAULT_SHELL_PREFERENCES,
  shellPreferencesSchema,
} from "@shared/preferences";
import { expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";

// The review of the language choice (language-choice.md): a view from before it
// reads the look strictly, so the captain's choice never reaches it, on a push
// or a read, and a view listing the change reads the whole look.
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
  const old = await connectClient(grant, { changes: [] });
  const current = await connectClient(grant, { changes: ["language-choice"] });
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

// The approved font plan (INF-3982, font-choice.md): a view that reads the
// language but not the fonts is never pushed or answered the fonts, and a
// view listing both reads the whole look.
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
  const older = await connectClient(grant, { changes: ["language-choice"] });
  const current = await connectClient(grant, { changes: ["language-choice", "font-choice"] });
  const olderAppearance = appearanceSchema.omit({ fonts: true });
  const { fonts: _chosen, ...withoutFonts } = look.appearance;
  expect(olderAppearance.parse(await older.invoke("inf:settings:appearance:get", []))).toEqual(
    withoutFonts,
  );
  expect(await current.invoke("inf:settings:appearance:get", [])).toEqual(look.appearance);
  at.events.emit("inf:shell:preferences", look);
  const pushed = await older.push((push) => push.channel === "inf:shell:preferences");
  expect(olderAppearance.parse((pushed.payload as typeof look).appearance)).toEqual(withoutFonts);
  expect((await current.push((push) => push.channel === "inf:shell:preferences")).payload).toEqual(
    look,
  );
  await older.close();
  await current.close();
});
