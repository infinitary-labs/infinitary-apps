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
