import { DEFAULT_APPEARANCE } from "@shared/preferences";
import {
  WINDOW_ANSWER_WAIT_MS,
  WINDOW_ASK_LIVE,
  WINDOW_ASK_WORDS,
  type WindowAsk,
} from "@shared/windowAsks";
import { expect, it, vi } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";
import { ViewWindows, WINDOW_ASKS } from "../viewWindows";

/**
 * The captain's pick on the Settings parity review (add-window-target): the
 * first mate's change of a Mac's own setting is asked of that Mac's window
 * over the real connection, once, and only the connection asked can answer.
 */
const askOf = (client: Awaited<ReturnType<typeof connectClient>>, seen = 0) =>
  new Promise<WindowAsk>((resolve) => {
    const look = () => {
      const lives = client.lives.filter((entry) => entry.channel === WINDOW_ASK_LIVE);
      if (lives.length > seen) resolve(lives[seen]?.payload as WindowAsk);
      else setImmediate(look);
    };
    look();
  });

it("asks one window of a Mac over the connection, and hears that window's answer alone", async () => {
  let windows: ViewWindows | undefined;
  const at = await home({
    dispatch: (async (channel, args, actor) => {
      if (channel === "inf:view:answer") {
        const [id, answer] = args as [string, unknown];
        return windows?.answered(id, answer, actor);
      }
      throw new Error(`Unexpected ${channel}`);
    }) as CoreDispatch,
  });
  windows = new ViewWindows({
    liveToView: (deviceId, channel, payload, change) =>
      at.connection.liveToView(deviceId, channel, payload, change, true),
  });
  const grant = await at.join("view", "Studio");
  // Two windows of one Mac that know the asks, and one from before them.
  const older = await connectClient(grant, { changes: [] });
  const first = await connectClient(grant, { changes: [WINDOW_ASKS] });
  const newest = await connectClient(grant, { changes: [WINDOW_ASKS] });

  const studio = { deviceId: grant.deviceId, name: "Studio" };
  const asked = windows.ask(studio, "inf:settings:appearance:get", []);
  const frame = await askOf(newest);
  // Another window of the same Mac never saw the ask's id, so it cannot answer it.
  await first.invoke("inf:view:answer", [frame.id, { ok: true, result: { forged: true } }]);
  await newest.invoke("inf:view:answer", [
    frame.id,
    { ok: true, result: { ...DEFAULT_APPEARANCE, usageUnit: "usd" } },
  ]);
  await expect(asked).resolves.toMatchObject({ result: { usageUnit: "usd" } });
  expect(first.lives.filter((entry) => entry.channel === WINDOW_ASK_LIVE)).toEqual([]);
  expect(older.lives.filter((entry) => entry.channel === WINDOW_ASK_LIVE)).toEqual([]);
  await older.close();
  await first.close();
  await newest.close();
});

it("stops holding an ask once its wait runs out, so the window's late answer reaches nothing", async () => {
  let windows: ViewWindows | undefined;
  const answers: unknown[] = [];
  const at = await home({
    dispatch: (async (channel, args, actor) => {
      if (channel === "inf:view:answer") {
        answers.push(args);
        const [id, answer] = args as [string, unknown];
        return windows?.answered(id, answer, actor);
      }
      throw new Error(`Unexpected ${channel}`);
    }) as CoreDispatch,
  });
  windows = new ViewWindows({
    liveToView: (deviceId, channel, payload, change) =>
      at.connection.liveToView(deviceId, channel, payload, change, true),
  });
  const grant = await at.join("view", "Studio");
  const window = await connectClient(grant, { changes: [WINDOW_ASKS] });
  const studio = { deviceId: grant.deviceId, name: "Studio" };
  // Only the timers the ask sets are the test's clock; the connection keeps its own.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const asked = windows.ask(studio, "inf:settings:appearance:get", []);
  vi.advanceTimersByTime(WINDOW_ANSWER_WAIT_MS);
  vi.useRealTimers();
  await expect(asked).rejects.toThrow(WINDOW_ASK_WORDS.noAnswer("Studio"));
  const frame = await askOf(window);
  await window.invoke("inf:view:answer", [frame.id, { ok: true, result: DEFAULT_APPEARANCE }]);
  expect(answers).toEqual([]);
  await window.close();
});
