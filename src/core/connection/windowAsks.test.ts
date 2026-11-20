import { DEFAULT_APPEARANCE } from "@shared/preferences";
import { WINDOW_ASK_LIVE, type WindowAsk } from "@shared/windowAsks";
import { expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";
import { ViewWindows, WINDOW_ASKS } from "../viewWindows";

/**
 * The captain's pick on the Settings parity review (add-window-target): the
 * first mate's change of a Mac's own setting is asked of that Mac's window
 * over the real connection, once, and only the connection asked can answer.
 */
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
  const frame = await new Promise<WindowAsk>((resolve) => {
    const look = () => {
      const live = newest.lives.find((entry) => entry.channel === WINDOW_ASK_LIVE);
      if (live) resolve(live.payload as WindowAsk);
      else setImmediate(look);
    };
    look();
  });
  // Another window of the same Mac never saw the ask's id, so it cannot answer it.
  await first.invoke("inf:view:answer", [frame.id, { ok: true, result: { forged: true } }]);
  await newest.invoke("inf:view:answer", [
    frame.id,
    { ok: true, result: { ...DEFAULT_APPEARANCE, usageUnit: "usd" } },
  ]);
  await expect(asked).resolves.toMatchObject({ usageUnit: "usd" });
  expect(first.lives.filter((entry) => entry.channel === WINDOW_ASK_LIVE)).toEqual([]);
  expect(older.lives.filter((entry) => entry.channel === WINDOW_ASK_LIVE)).toEqual([]);
  await older.close();
  await first.close();
  await newest.close();
});
