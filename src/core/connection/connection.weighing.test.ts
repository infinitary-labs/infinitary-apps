import type { TaskBoardRead } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { type ConnectionClient, connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import type { CoreDispatch } from "../dispatcher";
import type { PhoneCatchUp } from "./catchUpLog";

/**
 * INF-6817's approved plan, piece 1, the captain's "Approve and build": the
 * home weighs each device's re-read by the shape it actually reads. A phone's
 * re-read reads the board without its closed rows, so a phone is never sent a
 * replay heavier than that; a computer's window keeps the weight it had, and a
 * whole board pushed never raises a phone's weight. Driven through the real
 * connection, a real phone hello and a board read from a real task record.
 */

/** A record with three live tasks and forty done this week: the whole board outweighs the light one. */
function record() {
  const f = taskProtocolFixture();
  for (let i = 1; i <= 43; i++) {
    f.tasks.create({
      id: `t-${i}`,
      title: `Measure the catch-up replay on the phone, part ${i}`,
      prompt: "Read the home's catch-up lines and say which replays were slow.",
      repoId: "r1",
    });
    f.tick();
    if (i > 3) {
      f.tasks.close(`t-${i}`, { status: "done", reason: "landed", actor: "captain" });
      f.tick();
    }
  }
  return f;
}

function weighingHome(f: ReturnType<typeof record>) {
  const dispatch = (async (channel, rawArgs) => {
    if (channel === "inf:cards:list") return [];
    if (channel === "inf:feed:recent")
      return [{ kind: "info", text: "INF-6817 planned the catch-up", at: 2000 }];
    if (channel === "inf:tasks:board") return f.protocol.board((rawArgs as [TaskBoardRead?])[0]);
    if (channel === "inf:conversation:last-turn") return null;
    if (channel === "inf:conversation:state") return { busy: false };
    if (channel === "inf:computers:presence") return [];
    throw new Error(`Unexpected request ${channel}`);
  }) as CoreDispatch;
  const lines: PhoneCatchUp[] = [];
  let heard: () => void = () => {};
  const at = home({
    dispatch,
    onCatchUp: (line) => {
      lines.push(line);
      heard();
    },
  });
  /** Resolves with the phone's catch-up line number `count`, once the phone acknowledged it. */
  const next = (count: number) =>
    new Promise<PhoneCatchUp>((resolve) => {
      heard = () => {
        if (lines.length >= count) resolve(lines[count - 1] as PhoneCatchUp);
      };
      heard();
    });
  return { at, next };
}

const PHONE = { system: { system: "ios" }, appVersion: "0.21.0" } as const;
const FIRST_READS = [
  "inf:cards:list",
  "inf:feed:recent",
  "inf:conversation:last-turn",
  "inf:conversation:state",
  "inf:computers:presence",
] as const;

/** A phone's reload as the phone asks it (`initialReads`, `refresh`): the board last, without its closed rows. */
async function phoneReloads(phone: ConnectionClient) {
  for (const channel of FIRST_READS) await phone.invoke(channel, []);
  await phone.invoke("inf:tasks:board", [{ closed: false }]);
}

/** A computer's window that reads the whole board, as one does once its Tasks shows Done or a search. */
async function windowReloads(window: ConnectionClient) {
  for (const channel of FIRST_READS) await window.invoke(channel, []);
  await window.invoke("inf:tasks:board", []);
}

/** First mate reply lines missed while away, each a numbered push. */
function missReplies(emit: (text: string) => void, count: number) {
  for (let i = 0; i < count; i++)
    emit(`Reply line ${i}: the phone's re-read reads the board without its closed rows.`);
}

describe("weighing each device's re-read by the shape it reads", () => {
  it("reloads a phone whose replay outweighs its own light re-read, while a window still replays", async () => {
    const f = record();
    const whole = Buffer.byteLength(JSON.stringify(f.protocol.board()));
    const light = Buffer.byteLength(JSON.stringify(f.protocol.board({ closed: false })));
    // The fixture's own premise: forty done tasks make the whole board several times the light one.
    expect(whole).toBeGreaterThan(light * 4);
    const { at: started, next } = weighingHome(f);
    const at = await started;
    const grant = await at.join();

    const phone = await connectClient(grant, PHONE);
    await phoneReloads(phone);
    const window = await connectClient(grant);
    await windowReloads(window);
    const cursor = phone.cursor();
    await phone.close();
    await window.close();

    // About half the whole board in reply lines: heavier than the phone's re-read, lighter than the window's.
    missReplies(
      (text) => at.events.emit("inf:event", { type: "firstmate_reply", text }),
      Math.ceil(whole / 2 / 150),
    );

    const windowBack = await connectClient(grant, { cursor });
    expect(windowBack.welcome.catchUp).toBe("replay");
    await windowBack.close();

    const back = await connectClient(grant, { ...PHONE, cursor });
    expect(back.welcome.catchUp).toBe("reload");
    await phoneReloads(back);
    const line = await next(2);
    expect(line).toMatchObject({ kind: "reload", why: "heavier" });
    // Weighed by the light board, never the whole one the window read last.
    expect(line.reloadWeight).toBeLessThan(whole);
    expect(line.missedBytes).toBeGreaterThan(line.reloadWeight ?? Infinity);
    await back.close();
  });

  it("keeps a phone's weight at its light re-read after a whole board is pushed", async () => {
    const f = record();
    const whole = Buffer.byteLength(JSON.stringify(f.protocol.board()));
    const { at: started, next } = weighingHome(f);
    const at = await started;
    const grant = await at.join();

    const phone = await connectClient(grant, PHONE);
    await phoneReloads(phone);
    at.events.emit("inf:tasks", f.protocol.board());
    await phone.push((push) => push.channel === "inf:tasks");
    const cursor = phone.cursor();
    await phone.close();

    missReplies(
      (text) => at.events.emit("inf:event", { type: "firstmate_reply", text }),
      Math.ceil(whole / 2 / 150),
    );

    const back = await connectClient(grant, { ...PHONE, cursor });
    expect(back.welcome.catchUp).toBe("reload");
    await phoneReloads(back);
    expect((await next(2)).reloadWeight).toBeLessThan(whole);
    await back.close();
  });
});
