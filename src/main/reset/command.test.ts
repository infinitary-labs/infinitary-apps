import * as m from "@shared/i18n/messages.generated";
import type { ResetAnswer } from "@shared/reset";
import { describe, expect, it } from "vitest";
import { answerResetCommand, RESET_USAGE, type ResetCommandSeams, resetCommand } from "./command";

/**
 * The reset command (docs/reset.md, "The reset command"): a reset that
 * starts with no window, which only the person at this computer can confirm,
 * so a shell an agent drives never wipes anything.
 */

function seams(overrides: Partial<ResetCommandSeams> = {}) {
  const steps: string[] = [];
  const base: ResetCommandSeams = {
    canConfirm: async () => true,
    holdFolder: () => {
      steps.push("hold");
      return true;
    },
    releaseFolder: () => steps.push("release"),
    reset: async (): Promise<ResetAnswer> => {
      steps.push("reset");
      return { outcome: "restarting" };
    },
    finish: async () => {
      steps.push("finish");
      return "done";
    },
  };
  return { steps, seams: { ...base, ...overrides } };
}

describe("the reset command", () => {
  it("is the word reset after the app's own arguments", () => {
    expect(resetCommand(["/app/Infinitary", "reset"], false)).toEqual([]);
    expect(resetCommand(["/app/Infinitary", "help"], false)).toBeNull();
  });

  it("confirms, lets the folder go, then wipes it and says it opens as just installed", async () => {
    const { steps, seams: s } = seams();
    expect(await answerResetCommand([], s)).toEqual({
      code: 0,
      out: `${m.resetCommandDone()}\n`,
      error: "",
    });
    expect(steps).toEqual(["hold", "reset", "release", "finish"]);
  });

  it("wipes nothing where the system cannot ask the person to confirm", async () => {
    for (const canConfirm of [async () => false, () => Promise.reject(new Error("none"))]) {
      const { steps, seams: s } = seams({ canConfirm });
      expect(await answerResetCommand([], s)).toMatchObject({
        code: 1,
        error: `${m.resetCommandNoConfirmation()}\n`,
      });
      expect(steps).toEqual([]);
    }
  });

  it("wipes nothing while Infinitary runs on the folder", async () => {
    const { steps, seams: s } = seams({ holdFolder: () => false });
    expect(await answerResetCommand([], s)).toMatchObject({
      error: `${m.resetCommandRunning()}\n`,
    });
    expect(steps).toEqual([]);
  });

  it("wipes nothing when the person did not confirm, and lets the folder go", async () => {
    const { steps, seams: s } = seams({
      reset: async () => {
        steps.push("reset");
        return { outcome: "kept" };
      },
    });
    expect(await answerResetCommand([], s)).toMatchObject({ error: `${m.resetCommandKept()}\n` });
    expect(steps).toEqual(["hold", "reset", "release"]);
  });

  it("says the next start finishes it when another program holds the folder", async () => {
    const { seams: s } = seams({ finish: async () => "held" });
    expect(await answerResetCommand([], s)).toMatchObject({
      code: 1,
      error: `${m.resetHeldMessage()}. ${m.resetHeldDetail()}\n`,
    });
  });

  it("refuses extra words with its usage", async () => {
    const { steps, seams: s } = seams();
    expect(await answerResetCommand(["--yes"], s)).toEqual({
      code: 2,
      out: "",
      error: `${RESET_USAGE}\n`,
    });
    expect(steps).toEqual([]);
  });
});
