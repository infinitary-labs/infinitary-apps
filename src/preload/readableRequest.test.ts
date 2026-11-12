import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readableRequest } from "./readableRequest";

// A card's Save shows its refusal in the file's row, as act and reply show theirs (INF-3757).
const channels = ["inf:cards:act", "inf:cards:reply", "inf:cards:save-file"] as const;
const FALLBACKS = {
  "inf:cards:act": /^Could not use this choice\. Please try again\.$/,
  "inf:cards:reply": /^Could not send this reply\. Please try again\.$/,
  "inf:cards:save-file": /^Could not save this file\. Please try again\.$/,
} as const;

for (const channel of channels) {
  describe(channel, () => {
    it("passes the acceptance receipt through unchanged", async () => {
      const receipt = { effect: { kind: "open", target: "settings" } };
      expect(await readableRequest(channel, async () => receipt)).toBe(receipt);
    });

    it.each(["Error", "TypeError"])(
      "keeps the refusal reason without Electron or %s syntax",
      async (name) => {
        await expect(
          readableRequest(channel, async () => {
            throw new Error(
              `Error invoking remote method '${channel}': ${name}: This card is closed.`,
            );
          }),
        ).rejects.toThrow(/^This card is closed\.$/);
      },
    );

    it("preserves an undecorated reason, including its line breaks and quoted words", async () => {
      const reason = 'Choose "Keep" instead.\nYour work has not been merged.';
      await expect(
        readableRequest(channel, async () => {
          throw new Error(reason);
        }),
      ).rejects.toThrow(reason);
    });

    it.each([
      null,
      {},
      new Error(""),
      new Error(`Error invoking remote method '${channel}': Error: `),
      new Error(`Error invoking remote method '${channel}': Error`),
      new Error(`Error invoking remote method '${channel}': TypeError`),
      new Error(`Error invoking remote method '${channel}': [object Object]`),
      new Error(`Error invoking remote method '${channel}': null`),
      new Error(`Error invoking remote method '${channel}': undefined`),
      new Error(
        `Error invoking remote method '${channel}': ZodError: [{ "message": "invalid input" }]`,
      ),
      z.string().safeParse(1).error,
      new Error("Error invoking remote method 'another-method': Error: failed"),
      new Error(
        `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
      ),
    ])("uses readable fallback for a failure with no usable reason (%s)", async (failure) => {
      await expect(
        readableRequest(channel, async () => {
          throw failure;
        }),
      ).rejects.toThrow(FALLBACKS[channel]);
    });
  });
}

const settingsCases = [
  ["inf:accounts:custom:review", "Could not review this server address"],
  ["inf:quota:refresh", "Could not refresh your plan's allowance"],
  ["inf:models:slots", "Could not load models"],
  ["inf:accounts:add", "Could not add this account"],
  ["inf:accounts:sign-in", "Could not sign in to this account"],
  ["inf:settings:routing:set", "Could not save routing"],
  ["inf:settings:firstmate-account:set", "Could not change Firstmate's account"],
  ["inf:settings:dictation:set", "Could not save dictation"],
  ["inf:settings:notifications:set", "Could not save notifications"],
  ["inf:presence:set", "Could not save start-at-login and dock settings"],
  ["inf:models:slots:set", "Could not save model slots"],
  ["inf:models:slots:reset", "Could not reset model slots"],
  ["inf:settings:decisions:set", "Could not save the decision model"],
  ["inf:decisions:key:set", "Could not save the decision model key"],
  ["inf:decisions:key:remove", "Could not remove the decision model key"],
  ["inf:retention:purge", "Purge did not complete"],
  ["inf:settings:firstmate-model:set", "Could not change Firstmate's model"],
  ["inf:settings:appearance:set", "Could not save this setting"],
  ["inf:settings:panels:set", "Could not change your panels"],
  ["inf:settings:sharing:set", "Could not change sharing"],
  ["inf:settings:sharing:ask", "Could not save your answer"],
  ["inf:settings:sharing:viewed", "Could not save your answer"],
  ["inf:accounts:list", "Could not read your accounts"],
  ["inf:accounts:rename", "Could not rename this account"],
  ["inf:accounts:pin", "Could not change which account crew work prefers"],
  ["inf:accounts:set-enabled", "Could not pause or resume this account"],
  ["inf:accounts:remove", "Could not disconnect this account"],
] as const;

for (const [channel, operation] of settingsCases) {
  describe(channel, () => {
    it("passes a successful response through unchanged", async () => {
      const result = { id: "acct_new", purgedTasks: 2 };
      expect(await readableRequest(channel, async () => result)).toBe(result);
    });

    it.each([
      "",
      `Error invoking remote method '${channel}': Error: `,
      `Error invoking remote method '${channel}': TypeError: `,
    ])("names the failed operation and preserves the useful reason (%s)", async (decoration) => {
      const reason = 'Try "Work" instead.\nThe service is unavailable.';
      await expect(
        readableRequest(channel, async () => {
          throw new Error(decoration + reason);
        }),
      ).rejects.toMatchObject({ message: `${operation}: ${reason}` });
    });

    it.each([
      undefined,
      "failed",
      {},
      new Error(""),
      new Error(`Error invoking remote method '${channel}': TypeError: `),
      new Error(`Error invoking remote method '${channel}': Error`),
      new Error(`Error invoking remote method '${channel}': TypeError`),
      new Error(`Error invoking remote method '${channel}': [object Object]`),
      new Error(`Error invoking remote method '${channel}': null`),
      new Error(`Error invoking remote method '${channel}': undefined`),
      new Error(`Error invoking remote method '${channel}': ZodError: invalid response`),
      z.string().safeParse(1).error,
      new Error("Error invoking remote method 'another-method': Error: failed"),
      new Error(`No handler registered for '${channel}'`),
    ])("falls back to the failed operation, not diagnostics (%s)", async (failure) => {
      await expect(
        readableRequest(channel, async () => {
          throw failure;
        }),
      ).rejects.toMatchObject({ message: `${operation}. Please try again.` });
    });
  });
}
