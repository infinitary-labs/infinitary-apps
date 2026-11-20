import { createContext, runInContext } from "node:vm";
import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { pressWindowKey } from "./e2e/windowKeys";

const COLLECTED = "electronApplication.evaluate: Resulting promise was garbage collected.";

/** What a busy main process loses of one evaluation to a garbage collection. */
type Loss = "answer" | "press";

/**
 * A stand-in for the app's main process. Each evaluation runs the function
 * from its source in one realm that outlives it, as Playwright runs it in
 * the main process, against one window that records the keys it is sent.
 * The next evaluations lose what `losses` names: the answer after the
 * function ran, or the evaluation before it ran.
 */
function mainProcess(losses: Loss[] = []) {
  const keys: string[] = [];
  const window = {
    webContents: {
      getURL: () => "file:///index.html",
      sendInputEvent: (event: { type: string; keyCode: string; modifiers: string[] }) =>
        keys.push([event.type, ...event.modifiers, event.keyCode].join(" ")),
    },
  };
  const electron = { BrowserWindow: { getAllWindows: () => [window] } };
  const realm = createContext({});
  const app = {
    evaluate: async (run: (electron: unknown, arg: unknown) => unknown, arg: unknown) => {
      const loss = losses.shift();
      if (loss === "press") throw new Error(COLLECTED);
      const answer = runInContext(`(${run.toString()})`, realm)(electron, arg);
      if (loss === "answer") throw new Error(COLLECTED);
      return answer;
    },
  } as unknown as ElectronApplication;
  return { app, keys };
}

describe("pressWindowKey", () => {
  it("sends the key down and up once", async () => {
    const { app, keys } = mainProcess();
    await pressWindowKey(app, "k", ["shift"]);
    expect(keys).toEqual(["keyDown shift k", "keyUp shift k"]);
  });

  it.each<{ losses: Loss[] }>([
    { losses: ["answer"] },
    { losses: ["press"] },
    { losses: ["answer", "press", "answer"] },
  ])("sends the key once when the main process loses $losses", async ({ losses }) => {
    const { app, keys } = mainProcess(losses);
    await pressWindowKey(app, "Enter");
    expect(keys).toEqual(["keyDown Enter", "keyUp Enter"]);
  });

  it("sends a second press of the same key whose answer is lost too", async () => {
    const { app, keys } = mainProcess(["answer", "answer"]);
    await pressWindowKey(app, "Tab");
    await pressWindowKey(app, "Tab");
    expect(keys).toEqual(["keyDown Tab", "keyUp Tab", "keyDown Tab", "keyUp Tab"]);
  });

  it("fails at once on any other error", async () => {
    const app = {
      evaluate: async (run: (electron: unknown, arg: unknown) => unknown, arg: unknown) =>
        runInContext(`(${run.toString()})`, createContext({}))(
          { BrowserWindow: { getAllWindows: () => [] } },
          arg,
        ),
    } as unknown as ElectronApplication;
    await expect(pressWindowKey(app, "k")).rejects.toThrow("App window missing");
  });
});
