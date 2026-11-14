import type { ComputerResourcesView } from "@shared/resources";
import { expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { changed, home } from "../../../tests/helpers/connectionHome";
import { STREAMED_EVENTS_LIVE } from "./connection";

// What goes outside the numbering (docs/connection.md, "Live pushes"), on the
// connection with a stand-in core as src/core/connection/connection.test.ts
// drives it: a view from major 16 on, or one on major 15 that names the
// addition, reads each as a `live` frame; a view on major 15 that does not
// keeps the numbered form; and a phone is sent none.

// INF-3750's option D: streamed reply pieces and tool starts and ends filled the journal, so a short gap reloaded,
// and the phone, which never reads them, was sent every one.
it("keeps streamed reply pieces and tool events out of the numbering, so a short gap still replays", async () => {
  const at = await home({ journal: { entries: 4, bytes: 1_000_000 } });
  const grant = await at.join();
  // A view on major 15 reads them live once it names the change; one that does not keeps the numbered form.
  const current = await connectClient(await at.join(), {
    protocolVersion: "15.0.0",
    changes: [STREAMED_EVENTS_LIVE],
  });
  const older = await connectClient(await at.join(), { protocolVersion: "15.0.0", changes: [] });
  const phone = await connectClient(await at.join(), { system: { system: "ios" } });
  const first = await connectClient(grant);
  changed(at.events);
  await first.push(() => true);
  const cursor = first.cursor();
  await first.close();

  const turn = [
    { type: "thinking_delta", taskId: "t1", text: "Reading the tide table" },
    { type: "assistant_delta", taskId: "t1", text: "The harbour " },
    { type: "assistant_delta", taskId: "t1", text: "opens at six." },
    { type: "tool_start", taskId: "t1", callId: "c1", toolName: "bash" },
    { type: "tool_end", taskId: "t1", callId: "c1", toolName: "bash", isError: false },
  ] as const;
  for (let round = 0; round < 4; round++)
    for (const event of turn) at.events.emit("inf:event", event);
  const priced = {
    type: "tool_end",
    taskId: "t1",
    callId: "c2",
    toolName: "subagent",
    isError: false,
    usage: { input: 1200, output: 300 },
  } as const;
  at.events.emit("inf:event", priced);
  changed(at.events);

  // Twenty streamed events against a journal of four: only the two numbered pushes are kept.
  const back = await connectClient(grant, { cursor });
  expect(back.welcome.catchUp).toBe("replay");
  expect(back.pushes.map((push) => [push.seq, push.channel])).toEqual([
    [cursor.seq + 1, "inf:event"],
    [cursor.seq + 2, "inf:models:changed"],
  ]);
  expect(back.pushes[0]?.payload).toEqual(priced);
  expect(back.lives).toEqual([]);

  for (const view of [current, older, phone])
    await view.push((push) => push.seq === cursor.seq + 2);
  const streamed = Array.from({ length: 4 }, () => turn).flat();
  // A current view reads them live, outside the numbering.
  expect(current.lives).toEqual(streamed.map((payload) => ({ channel: "inf:event", payload })));
  expect(current.pushes.map((push) => push.seq)).toEqual([
    cursor.seq,
    cursor.seq + 1,
    cursor.seq + 2,
  ]);
  // A view from before the change reads them as before, under the newest number already sent.
  expect(older.lives).toEqual([]);
  expect(
    older.pushes.filter((push) => push.seq === cursor.seq).map((push) => push.payload),
  ).toEqual([{ ok: true }, ...streamed]);
  // The phone never reads them, so it is sent none.
  expect(phone.lives).toEqual([]);
  expect(phone.pushes.map((push) => push.seq)).toEqual([
    cursor.seq,
    cursor.seq + 1,
    cursor.seq + 2,
  ]);
});

// INF-3851's piece 3: while crew work runs the home pushes the computers' readings every two seconds, and the
// phone, which never shows them, was sent every one and woken to read it.
it("sends the computers' readings outside the numbering, and none to a phone", async () => {
  const at = await home({ journal: { entries: 4, bytes: 1_000_000 } });
  const grant = await at.join();
  // Every view from major 16 on reads them live; one on major 15 keeps the numbered form until it names the change.
  const current = await connectClient(await at.join(), { changes: [] });
  const older = await connectClient(await at.join(), { protocolVersion: "15.0.0", changes: [] });
  const phone = await connectClient(await at.join(), { system: { system: "ios" } });
  const first = await connectClient(grant);
  changed(at.events);
  await first.push(() => true);
  const cursor = first.cursor();
  await first.close();

  const readings: ComputerResourcesView[] = (
    ["missing", "timeout", "stale", "out-of-reach", "missing", "timeout"] as const
  ).map((reason) => ({
    computers: [
      { computerId: null, label: "This Mac", reading: { status: "unknown", reason } },
      {
        computerId: "mac-mini",
        label: "Mac mini",
        reading: { status: "unknown", reason: "out-of-reach" },
      },
    ],
  }));
  for (const reading of readings) at.events.emit("inf:computers:resources", reading);
  changed(at.events);

  // Six readings against a journal of four: only the one numbered push is kept, so the gap still replays.
  const back = await connectClient(grant, { cursor });
  expect(back.welcome.catchUp).toBe("replay");
  expect(back.pushes.map((push) => [push.seq, push.channel])).toEqual([
    [cursor.seq + 1, "inf:models:changed"],
  ]);
  expect(back.lives).toEqual([]);

  for (const view of [current, older, phone])
    await view.push((push) => push.seq === cursor.seq + 1);
  // A current view reads them live, outside the numbering.
  expect(current.lives).toEqual(
    readings.map((payload) => ({ channel: "inf:computers:resources", payload })),
  );
  expect(current.pushes.map((push) => push.seq)).toEqual([cursor.seq, cursor.seq + 1]);
  // A view from before the change reads them as before, under the newest number already sent.
  expect(older.lives).toEqual([]);
  expect(
    older.pushes.filter((push) => push.seq === cursor.seq).map((push) => push.payload),
  ).toEqual([{ ok: true }, ...readings]);
  // The phone never shows them, so it is sent none, and its numbering stays whole.
  expect(phone.lives).toEqual([]);
  expect(phone.pushes.map((push) => [push.seq, push.channel])).toEqual([
    [cursor.seq, "inf:models:changed"],
    [cursor.seq + 1, "inf:models:changed"],
  ]);
});
