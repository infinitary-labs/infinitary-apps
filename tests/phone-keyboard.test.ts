import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLoadClock, waitCap } from "./helpers/budgets";
import {
  changePhoneTextSize,
  hardwareKeyboardArguments,
  observePhoneKeyboard,
  PHONE_DISPLAY_REQUEST_BUDGET_MS,
  PHONE_HARDWARE_KEYBOARD_STATE,
  PHONE_TOUCH_REQUEST_BUDGET_MS,
  PhoneDisplayChanges,
  PhoneKeyRegistrations,
  PhonePickerPreviews,
  PhoneTouchOutcomes,
  phoneApplicationPid,
  phoneDisplayDeadline,
  phoneLogMilliseconds,
  withPhoneHardwareKeyboard,
} from "./helpers/phoneKeyboard";
import { observePhoneLog } from "./helpers/phoneLogs";
import { logTime } from "./helpers/phonePhotos";
import { scratchDir } from "./helpers/scratchDirs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

// INF-355: the event router must acknowledge a chord before the native test sends it.
// These are the relevant real readings from its failing 54571 process, not an app-side command list.
const registration = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-17 20:54:17.626",
  eventMessage: String.raw`new key command registrations for pid:54571 environment: keyboardFocus; token: 0x187EFC0B; keyCommands: {
    cmd|opt|shft: (v),
    cmd: (b, (50:leftArrow), ",", c, (51:downArrow), "-", (52:upArrow), e, f, g, u, "?", v, "[", i, w, x, z, "\^M", a, (4F:rightArrow), "+"),
    glb|ctrl|opt|shft|capslock|numpad: (" "),
    cmd|shft: (k, z, g),
    glb: (e, d),
    cmd|opt: (f, w),
    cmd|ctrl: (" ")
}`,
};
// The resumed full iPhone run emitted a literal Return inside its ndjson message.
// Unlike log's compact output above, this is not the printed \\^M spelling.
const ndjsonRegistration = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-18 00:46:50.430122-0700",
  eventMessage: `new key command registrations for pid:77224 environment: keyboardFocus; token: 0x68D23FFE; keyCommands: {
    cmd|opt|shft: (v),
    cmd: (b, (50:leftArrow), ",", c, (51:downArrow), "-", (52:upArrow), e, f, g, u, "?", v, "[", i, w, x, z, "\r", a, (4F:rightArrow), "+"),
    glb|ctrl|opt|shft|capslock|numpad: (" "),
    cmd|shft: (k, z, g),
    glb: (e, d),
    cmd|opt: (f, w),
    cmd|ctrl: (" ")
}`,
};
// INF-82: the last iPhone reading before its missing PID, and the sibling iPad paging reading.
const beforeRelaunch = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-18 19:28:54.561884-0700",
  eventMessage:
    'new key command registrations for pid:19471 environment: keyboardFocus; token: 0x4B9CD982; keyCommands: {\n    cmd|opt|shft: (v),\n    cmd: ("?", f, v, g, w, x, i, ",", "\r", a, "[", c, (4F:rightArrow), (50:leftArrow), (52:upArrow), (51:downArrow), z, e),\n    glb|ctrl|opt|shft|capslock|numpad: (" "),\n    cmd|shft: (g, k, z),\n    glb: (e, d),\n    cmd|opt: (w, f),\n    cmd|ctrl: (" ")\n}',
};
const afterRelaunch = {
  processImagePath: "/usr/libexec/backboardd",
  timestamp: "2026-10-18 19:42:03.409124-0700",
  eventMessage:
    'new key command registrations for pid:80895 environment: keyboardFocus; token: 0x8BD835D2; keyCommands: {\n    cmd|opt|shft: (v),\n    cmd: ("?", f, v, g, w, x, i, ",", a, "[", c, (4F:rightArrow), (50:leftArrow), (52:upArrow), (51:downArrow), z, e),\n    glb|ctrl|opt|shft|capslock|numpad: (" "),\n    cmd|shft: (k, "]", g, z),\n    glb: (e, d),\n    cmd|opt: (w, f),\n    cmd|ctrl: (" ")\n}',
};
const pid = Number(/pid:(\d+)/.exec(registration.eventMessage)?.[1]);
const dismiss = { key: "k", modifiers: ["shft", "cmd"] };

afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
});

describe("the native chord's backboard registration witness (INF-355)", () => {
  it("does not release a chord until the router, rather than the app, acknowledges it", async () => {
    vi.useFakeTimers();
    const reader = new PhoneKeyRegistrations();
    let dispatched = false;
    const ready = reader.wait(pid, dismiss).then(() => {
      dispatched = true;
    });
    reader.receive({
      processImagePath: "/Applications/Infinitary.app/Infinitary",
      eventMessage:
        "flushing changes: {\n    contentsMask: 0x8; keyCommandsRegistrations: [environment: keyboardFocus; token: 0x187EFC0B; keyCommands: 33];\n}",
    });
    await Promise.resolve();
    expect(dispatched).toBe(false);
    reader.receive(registration);
    await ready;
    expect(dispatched).toBe(true);
    reader.close();
  });

  it.each([registration, ndjsonRegistration])(
    "reads the actual modifier groups and Return spelling from $timestamp",
    async (record) => {
      vi.useFakeTimers();
      const reader = new PhoneKeyRegistrations();
      reader.receive(record);
      const registeredPid = Number(/pid:(\d+)/.exec(record.eventMessage)?.[1]);
      for (const chord of [
        dismiss,
        { key: "i", modifiers: ["cmd"] },
        { key: "\r", modifiers: ["cmd"] },
      ]) {
        const ready = expect(reader.wait(registeredPid, chord)).resolves.toMatchObject({
          pid: registeredPid,
          timestamp: record.timestamp,
          ...chord,
        });
        await Promise.all([ready, vi.runAllTimersAsync()]);
      }
      reader.close();
    },
  );

  // INF-1066: the scene's registered arrows must use the same event-router witness.
  // Reuse the captured BackBoard HID readings; the native journey supplies unmodified browsing proof.
  it("normalizes real arrow registrations without inventing modifier-free readiness", async () => {
    vi.useFakeTimers();
    const reader = new PhoneKeyRegistrations();
    reader.receive(registration);
    for (const key of ["leftArrow", "rightArrow", "upArrow", "downArrow"]) {
      await expect(reader.wait(pid, { key, modifiers: ["cmd"] })).resolves.toMatchObject({
        pid,
        key,
        modifiers: ["cmd"],
      });
    }
    await expect(reader.wait(pid, { key: " ", modifiers: ["cmd", "ctrl"] })).resolves.toMatchObject(
      { pid, key: " " },
    );
    const missing = expect(reader.wait(pid, { key: "rightArrow", modifiers: [] })).rejects.toThrow(
      "No backboard registration",
    );
    await vi.runAllTimersAsync();
    await missing;
    reader.close();
  });

  it("never uses the wrong modifiers or a previous process's registration", async () => {
    vi.useFakeTimers();
    const reader = new PhoneKeyRegistrations();
    reader.receive(registration);
    const missing = expect(reader.wait(pid, { key: "k", modifiers: ["cmd"] })).rejects.toThrow(
      "No backboard registration",
    );
    // The later before-wait journey's app PID, not the old process that supplied this registration.
    const relaunched = expect(reader.wait(11487, dismiss)).rejects.toThrow(
      "No backboard registration",
    );
    await vi.runAllTimersAsync();
    await Promise.all([missing, relaunched]);
    reader.close();
  });

  it("fails closed if its observer ends, even when an earlier witness was cached", async () => {
    const reader = new PhoneKeyRegistrations();
    const pending = expect(reader.wait(pid, dismiss)).rejects.toThrow("observer stopped");
    reader.close();
    await pending;
    const cached = new PhoneKeyRegistrations();
    cached.receive(registration);
    cached.close();
    await expect(cached.wait(pid, dismiss)).rejects.toThrow("observer stopped");
  });

  it("renews a still-open subscription before relaunch without reusing its witnesses or losing evidence", async () => {
    const evidence = scratchDir("phone-keyboard-relaunch-");
    const children = new Set<ChildProcess>();
    const streams: ReturnType<typeof makeChild>[] = [];
    function makeChild() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          stdout.end();
          stderr.end();
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          return true;
        }),
      });
      return child;
    }
    spawn.mockImplementation(() => {
      // Closing and joining the old writer is a prerequisite, not a background cleanup.
      if (streams.length) {
        expect(children.size).toBe(0);
        expect(streams[0]?.stdout.destroyed).toBe(true);
        expect(streams[0]?.stderr.destroyed).toBe(true);
      }
      const child = makeChild();
      streams.push(child);
      queueMicrotask(() =>
        child.stdout.write("Filtering the log data using the registration predicate\n"),
      );
      return child;
    });
    const observer = await observePhoneKeyboard({
      simulator: "E673564E-BBAF-46DD-BAA4-A458F11C1AF6",
      env: {},
      evidence,
      children,
    });
    const previousPid = Number(/pid:(\d+)/.exec(beforeRelaunch.eventMessage)?.[1]);
    const nextPid = Number(/pid:(\d+)/.exec(afterRelaunch.eventMessage)?.[1]);
    const next = { key: "]", modifiers: ["cmd", "shft"] };
    streams[0]?.stdout.write(`${JSON.stringify(beforeRelaunch)}\n`);
    await expect(observer.wait(previousPid, dismiss)).resolves.toMatchObject({ pid: previousPid });
    // Like INF-82's failed run, the old child stays open but supplies no new-process record.
    const oldWait = expect(observer.wait(nextPid, next)).rejects.toThrow("observer stopped");
    await expect(observer.beforeLaunch()).resolves.toEqual({ generation: 2 });
    await oldWait;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(streams[0]?.kill).toHaveBeenCalledTimes(1);
    let released = false;
    const ready = observer.wait(nextPid, next).then((witness) => {
      released = true;
      return witness;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    streams[1]?.stdout.write(`${JSON.stringify(afterRelaunch)}\n`);
    await expect(ready).resolves.toMatchObject({ pid: nextPid, ...next });
    const noCachedOldProcess = expect(observer.wait(previousPid, dismiss)).rejects.toThrow(
      "observer stopped",
    );
    await observer.close();
    await noCachedOldProcess;
    expect(children.size).toBe(0);
    const saved = gunzipSync(
      readFileSync(join(evidence, "keyboard-registrations.ndjson.gz")),
    ).toString();
    expect(saved.split("\n").filter((line) => line.startsWith("{"))).toEqual([
      JSON.stringify(beforeRelaunch),
      JSON.stringify(afterRelaunch),
    ]);
  });

  // INF-230 offline review: either evidence writer must fail readiness without bypassing cleanup.
  it.each(["keyboard-registrations.ndjson.gz", "keyboard-registrations.stderr"])(
    "closes its observer and both streams when %s cannot be written",
    async (file) => {
      const evidence = scratchDir("phone-keyboard-writer-");
      // A real EISDIR, not an invented error or a failing simulator command.
      mkdirSync(join(evidence, file));
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let stopped = false;
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          if (!stopped) {
            stopped = true;
            stdout.end();
            stderr.end();
            queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          }
          return true;
        }),
      });
      spawn.mockImplementation(() => {
        queueMicrotask(() => {
          stdout.write("Filtering the log data using the registration predicate\n");
          stdout.write(`${JSON.stringify(registration)}\n`);
        });
        return child;
      });
      const children = new Set<ChildProcess>();
      const observer = await observePhoneKeyboard({
        simulator: "DA593B42-3668-49E5-AA53-39CA3677EABD",
        env: {},
        evidence,
        children,
      });
      await expect(observer.wait(11487, dismiss)).rejects.toThrow("EISDIR");
      await expect(observer.close()).rejects.toThrow("EISDIR");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(children.size).toBe(0);
      expect(stdout.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
    },
  );

  it("reads the app PID rather than its test runner from the owned simulator's service list", () => {
    // Actual service rows from the before-wait full iPhone journey.
    const services =
      "23175\t0\tUIKitApplication:com.getinfinitary.infinitary.uitests.xctrunner[6212][rb-legacy]\n11487\t0\tUIKitApplication:com.getinfinitary.infinitary[98ff][rb-legacy]";
    expect(phoneApplicationPid(services, "com.getinfinitary.infinitary")).toBe(11487);
    expect(() =>
      phoneApplicationPid(
        services.slice(0, services.indexOf("\n")),
        "com.getinfinitary.infinitary",
      ),
    ).toThrow("got 0");
  });
});

// UIKit publishes key commands only while a hardware keyboard is attached when its deferred update runs.
// The home attaches one to its own simulator for the wait; XCTest's own keyboard detaches within a millisecond.
// INF-1477 (the captain's choice "Allow a proven second tap"): phone run 40388726706's iPhone cards part.
// Its backboardd readings, at the compact log's millisecond times in that virtual Mac's UTC, around two taps:
// the card list's, delivered, and the pick of "Read the harbour chart", whose touches backboardd ignored.
const backboardd = "/usr/libexec/backboardd";
const earlierTap = {
  processImagePath: backboardd,
  timestamp: "2026-10-26 21:03:57.595000+0000",
  eventMessage:
    "init: <BKDirectTouchState: 0x10ab23560; touchScreen; builtin; senderID: 0x109C094000019; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};
const listTap = {
  processImagePath: backboardd,
  timestamp: "2026-10-26 21:03:58.314000+0000",
  eventMessage:
    "init: <BKDirectTouchState: 0x10ab23560; touchScreen; builtin; senderID: 0x109C09400001A; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};
const pickAttached = {
  processImagePath: backboardd,
  timestamp: "2026-10-26 21:04:01.403000+0000",
  eventMessage:
    "init: <BKDirectTouchState: 0x10ab21c00; touchScreen; accessory; authenticated: YES; senderID: 0x109C09400001B; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};
const pickIgnored = {
  processImagePath: backboardd,
  timestamp: "2026-10-26 21:04:01.406000+0000",
  eventMessage:
    "ignoring digitizer event for display <main> from unsupported service: (<BKIOHIDService: 0x10abd1a80; serviceStatus: matched; IOHIDService: IOHIDService name: id:0x109c09400001b primaryUsagePage:0xd primaryUsage:0x4 transport:Recap locationID:recap-bus-0 reportInterval:0 batchInterval:0 events:1 mask:0x800 sensorcontrols:7; senderID: 0x109C09400001B; displayUUID: 0x0; eventSource: verifiedExternalAccessory; primaryUsagePage: 0xD; primaryUsage: 0x4; authenticated: YES; builtIn: NO>):+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++\nTimestamp:           58597032975\nTimestamp type:      Absolute\nTotal Latency:       237 us\nSenderID:            0x000109C09400001B NON KERNEL SENDER\nBuiltIn:             1\nEventType:           Digitizer",
};
// When testmanagerd began synthesizing each tap, from the same log.
const listTapBegan = phoneLogMilliseconds("2026-10-26 21:03:58.307000+0000");
const pickBegan = phoneLogMilliseconds("2026-10-26 21:04:01.115000+0000");
// Phone run 40469903139's iPhone join part: backboardd read the tap on the link field as a bad usage pair, built in,
// and ignored its touches. The runner began that tap at 09:22:25.700 in that virtual Mac's UTC, by its own report.
const fieldAttached = {
  processImagePath: backboardd,
  timestamp: "2026-10-27 09:22:26.039000+0000",
  eventMessage:
    "init: <BKDirectTouchState: 0x10b2f8a80; bad usage pair: (0x0 / 0x4); builtin; senderID: 0x103BFDC000040; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};
const fieldIgnored = {
  processImagePath: backboardd,
  timestamp: "2026-10-27 09:22:26.043000+0000",
  eventMessage:
    "ignoring digitizer event for display <main> from unsupported service: (<BKIOHIDService: 0x10b25af00; serviceStatus: matched; IOHIDService: IOHIDService name: id:0x103bfdc000040 primaryUsagePage:0xd primaryUsage:0x4 transport:Recap locationID:recap-bus-0 reportInterval:0 batchInterval:0 events:1 mask:0x800 sensorcontrols:7; senderID: 0x103BFDC000040; displayUUID: 0x0; eventSource: builtin; primaryUsagePage: 0x0; primaryUsage: 0x4; authenticated: YES; builtIn: YES>):+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++\nTimestamp:           31243381944\nTimestamp type:      Absolute\nTotal Latency:       195 us",
};
const fieldTapBegan = Date.parse("2026-10-27T09:22:25.700Z");
// The Mac mini's iPad join part on Xcode 27.1 and iOS 27.0: backboardd read both taps' screens as accessories,
// named each screen on its contact lines and delivered the touches to the app.
const pasteContact = {
  processImagePath: backboardd,
  timestamp: "2026-10-27 21:41:38.782000-0700",
  eventMessage: "[10DAC72000000] contact 2 presence: touching",
};
const linkAttached = {
  processImagePath: backboardd,
  timestamp: "2026-10-27 21:51:39.898996-0700",
  eventMessage:
    "init: <BKDirectTouchState: 0x10552a800; touchScreen; accessory; builtIn: NO; displayIntegrated: YES; authenticated: YES; displayUUID: 509D2289-83E1-400C-AF22-AA1E14F71642; senderID: 0x10DAC76000001; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};
const linkContact = {
  processImagePath: backboardd,
  timestamp: "2026-10-27 21:51:39.899000-0700",
  eventMessage: "[10DAC76000001] contact 2 presence: touching",
};
const linkTapBegan = phoneLogMilliseconds("2026-10-27 21:51:39.894000-0700");

// INF-1917: phone run 40994573754, iPhone cards, the pager tap at t=274.27s.
// Its live simulator log lost these records; 12-xcrun.log kept both at millisecond precision.
const pagerAttached = {
  processImagePath: backboardd,
  timestamp: "2026-10-30 03:38:56.868000+0000",
  eventMessage:
    "init: <BKDirectTouchState: 0x10592c900; touchScreen; accessory; builtIn: NO; displayIntegrated: YES; authenticated: YES; displayUUID: BAE7661C-9A72-4F1D-AC88-D138EFE44128; senderID: 0x111885E000018; contacts: contacts: []; destinations: []; latentSystemGestureDestinations: ()>",
};
const pagerContact = {
  processImagePath: backboardd,
  timestamp: pagerAttached.timestamp,
  eventMessage: "[111885E000018] contact 2 presence: touching",
};
// testmanagerd began synthesizing the tap at this time in the same kept log.
const pagerTapBegan = phoneLogMilliseconds("2026-10-30 03:38:56.856000+0000");

describe("a tap's touch screen witness (INF-1477)", () => {
  it("recovers the pager tap's delivered witness when the live stream dropped it (INF-1917)", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async () => [pagerAttached, pagerContact]);
    const touches = new PhoneTouchOutcomes(recover);
    const read = touches.outcome(pagerTapBegan);
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual({
      outcome: "delivered",
      sender: "111885e000018",
      timestamp: pagerAttached.timestamp,
      proof: pagerContact.eventMessage,
    });
    expect(recover).toHaveBeenCalledOnce();
  });
  it("uses live proof without reading the kept log, and cancels recovery when live proof arrives (INF-1917)", async () => {
    vi.useFakeTimers();
    let release!: (records: object[]) => void;
    const pending = new Promise<object[]>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn((_since: number, _signal: AbortSignal) => pending);
    const touches = new PhoneTouchOutcomes(recover);
    const read = touches.outcome(pagerTapBegan);
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
    for (const record of [pagerAttached, pagerContact]) touches.receive(record);
    await expect(read).resolves.toMatchObject({
      outcome: "delivered",
      proof: pagerContact.eventMessage,
    });
    expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
    release([pickAttached, pickIgnored]);
    await pending;
    await expect(touches.outcome(pagerTapBegan)).resolves.toMatchObject({ outcome: "delivered" });
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original deadline if the kept-log reader stalls and never invents a discarded tap (INF-1917)", async () => {
    vi.useFakeTimers();
    let release!: (records: object[]) => void;
    const pending = new Promise<object[]>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn((_since: number, _signal: AbortSignal) => pending);
    const recovered = new PhoneTouchOutcomes(recover);
    const original = new PhoneTouchOutcomes();
    const read = recovered.outcome(pagerTapBegan);
    const unchanged = original.outcome(pagerTapBegan);
    // Run exactly the pre-existing witness deadline; recovery gets no additional wait.
    await vi.advanceTimersToNextTimerAsync();
    expect(await read).toEqual(await unchanged);
    expect(await read).toMatchObject({ outcome: "unknown" });
    expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
    release([pagerAttached, pagerContact]);
    await pending;
    expect(await read).toMatchObject({ outcome: "unknown" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires the same discarded proof from kept records and keeps a failed read unknown (INF-1917)", async () => {
    vi.useFakeTimers();
    const discarded = new PhoneTouchOutcomes(async () => [pickAttached, pickIgnored]);
    await expect(discarded.outcome(pickBegan)).resolves.toMatchObject({
      outcome: "discarded",
      proof: pickIgnored.eventMessage.split("\n")[0],
    });
    for (const recover of [
      async () => [pickAttached],
      async () => {
        throw new Error("log show exited with 1");
      },
    ]) {
      const reader = new PhoneTouchOutcomes(recover);
      const read = reader.outcome(pickBegan);
      await vi.runAllTimersAsync();
      await expect(read).resolves.toMatchObject({ outcome: "unknown" });
    }
  });

  it("reads the tap's own built-in touch screen as delivered, never an earlier tap's that arrives late", async () => {
    vi.useFakeTimers();
    const touches = new PhoneTouchOutcomes();
    let outcome: unknown;
    const read = touches.outcome(listTapBegan).then((value) => {
      outcome = value;
    });
    // The log stream can hand over another process's or an earlier tap's lines out of order.
    touches.receive(earlierTap);
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    touches.receive(listTap);
    await read;
    expect(outcome).toEqual({
      outcome: "delivered",
      sender: "109c09400001a",
      timestamp: listTap.timestamp,
      proof: listTap.eventMessage,
    });
  });

  it("proves a discarded tap only once backboardd reports ignoring the touches of its accessory screen", async () => {
    vi.useFakeTimers();
    const touches = new PhoneTouchOutcomes();
    touches.receive(earlierTap);
    touches.receive(listTap);
    let outcome: unknown;
    const read = touches.outcome(pickBegan).then((value) => {
      outcome = value;
    });
    touches.receive(pickAttached);
    await Promise.resolve();
    // An accessory screen alone is not proof that its touches went nowhere.
    expect(outcome).toBeUndefined();
    touches.receive(pickIgnored);
    await read;
    expect(outcome).toEqual({
      outcome: "discarded",
      sender: "109c09400001b",
      timestamp: pickAttached.timestamp,
      proof: pickIgnored.eventMessage.split("\n")[0],
    });
  });

  it("proves a discarded tap on a built-in screen backboardd read as a bad usage pair, never delivered", async () => {
    vi.useFakeTimers();
    const touches = new PhoneTouchOutcomes();
    let outcome: unknown;
    const read = touches.outcome(fieldTapBegan).then((value) => {
      outcome = value;
    });
    touches.receive(fieldAttached);
    await Promise.resolve();
    // Built in, but not read as a touch screen: like an accessory screen, it is not proof either way alone.
    expect(outcome).toBeUndefined();
    touches.receive(fieldIgnored);
    await read;
    expect(outcome).toEqual({
      outcome: "discarded",
      sender: "103bfdc000040",
      timestamp: fieldAttached.timestamp,
      proof: fieldIgnored.eventMessage.split("\n")[0],
    });
  });

  it("reads an iOS 27.0 accessory screen as delivered once backboardd reports its own contact touching", async () => {
    vi.useFakeTimers();
    const touches = new PhoneTouchOutcomes();
    touches.receive(pasteContact);
    let outcome: unknown;
    const read = touches.outcome(linkTapBegan).then((value) => {
      outcome = value;
    });
    touches.receive(linkAttached);
    await Promise.resolve();
    // The earlier tap's contact names another screen, so it is no proof for this one.
    expect(outcome).toBeUndefined();
    touches.receive(linkContact);
    await read;
    expect(outcome).toEqual({
      outcome: "delivered",
      sender: "10dac76000001",
      timestamp: linkAttached.timestamp,
      proof: linkContact.eventMessage,
    });
  });

  it("reads no proof as unknown, so the runner sends no second tap", async () => {
    vi.useFakeTimers();
    const touches = new PhoneTouchOutcomes();
    touches.receive(pickAttached);
    const unproven = touches.outcome(pickBegan);
    await vi.runAllTimersAsync();
    await expect(unproven).resolves.toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("No touch screen witness"),
    });
    // A stopped observer is not a witness either, even with the proof already cached.
    const stopped = new PhoneTouchOutcomes();
    stopped.receive(pickAttached);
    const pending = stopped.outcome(listTapBegan);
    stopped.close();
    await expect(pending).resolves.toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("observer stopped"),
    });
    stopped.receive(pickIgnored);
    await expect(stopped.outcome(pickBegan)).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("reads the owned simulator's kept log when its live tap subscription omitted the witness (INF-1917)", async () => {
    const evidence = scratchDir("phone-touch-recovery-");
    const children = new Set<ChildProcess>();
    const simulator = "53B86A21-6C98-4ADA-B450-3067365D6B8F";
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      queueMicrotask(() => {
        if (args.includes("stream")) {
          stdout.write("Filtering the log data using the registration predicate\n");
          // This tap's contact was absent from the live log in the failed run.
        } else {
          expect(args.slice(0, 5)).toEqual(["simctl", "spawn", simulator, "log", "show"]);
          for (const record of [pagerAttached, pagerContact])
            stdout.write(`${JSON.stringify(record)}\n`);
          end(0);
        }
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    await expect(observer.touch(pagerTapBegan)).resolves.toMatchObject({
      outcome: "delivered",
      proof: pagerContact.eventMessage,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    await observer.close();
    expect(children.size).toBe(0);
  });

  it("answers a tap's outcome and a photo tap's preview from the same renewed subscription as the chords", async () => {
    const evidence = scratchDir("phone-keyboard-touch-");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      }),
    });
    spawn.mockImplementation(() => {
      queueMicrotask(() =>
        stdout.write("Filtering the log data using the registration predicate\n"),
      );
      return child;
    });
    const children = new Set<ChildProcess>();
    const observer = await observePhoneKeyboard({
      simulator: "7D9C9633-B5F6-494B-B9F9-E8B92E0C6DA9",
      env: {},
      evidence,
      children,
    });
    const read = observer.touch(pickBegan);
    for (const record of [listTap, pickAttached, pickIgnored])
      stdout.write(`${JSON.stringify(record)}\n`);
    await expect(read).resolves.toMatchObject({ outcome: "discarded", sender: "109c09400001b" });
    const previewed = observer.preview(photoTapBegan);
    stdout.write(`${JSON.stringify(pickerHeld)}\n`);
    await expect(previewed).resolves.toMatchObject({
      previewed: true,
      proof: pickerHeld.eventMessage,
    });
    await observer.close();
    expect(children.size).toBe(0);
  });
});

// INF-1477 (the captain's choice "Allow one more photo tap"): phone run 40486884004's iPhone talk part, at the
// compact log's millisecond times in that virtual Mac's UTC. The iPhone delivered the second photo tap, but its lift
// reached the photo picker 1.65 seconds late: the picker opened the photo's preview, then logged its context menu
// line as it handled the lift, and chose nothing.
const photosPicker = "/System/Library/ExtensionKit/Extensions/PhotosPicker.appex/PhotosPicker";
const pickerPreviewOpened = {
  processImagePath: photosPicker,
  timestamp: "2026-10-27 11:06:58.651000+0000",
  eventMessage:
    "Current asset changed and not scrubbing. UUID: B84E8479-475C-4727-A4A4-B77AA9980897",
};
const pickerHeld = {
  processImagePath: photosPicker,
  timestamp: "2026-10-27 11:06:59.624000+0000",
  eventMessage: "performAllAnimations for animator: <_UIContextMenuAnimator: 0x1162914d0>",
};
// When testmanagerd began synthesizing that photo tap, and when the runner asked for the next tap's outcome.
const photoTapBegan = phoneLogMilliseconds("2026-10-27 11:06:57.803000+0000");
const nextTapBegan = phoneLogMilliseconds("2026-10-27 11:07:28.133000+0000");

// INF-2305: main run 41429548461's rest iPhone logged this real Photos response in simulator-live.log
// (line 405931), but its narrow registration stream omitted it. The test home recorded this press's start.
const restPhotoPress = Date.parse("2026-11-02T13:28:54.217Z");
const restPickerHeld = {
  processImagePath: photosPicker,
  timestamp: "2026-11-02 13:28:56.433000+0000",
  eventMessage: "performAllAnimations for animator: <_UIContextMenuAnimator: 0x1107ff1b0>",
};

describe("a photo tap the picker read as a press-and-hold (INF-1477)", () => {
  it("proves the press-and-hold only by the picker's context menu line after the tap began", async () => {
    vi.useFakeTimers();
    const previews = new PhonePickerPreviews();
    let preview: unknown;
    const read = previews.preview(photoTapBegan).then((value) => {
      preview = value;
    });
    // The picker opening a preview is not the end of the press, and backboardd's lines are not the picker's.
    previews.receive(pickerPreviewOpened);
    previews.receive(listTap);
    await Promise.resolve();
    expect(preview).toBeUndefined();
    previews.receive(pickerHeld);
    await read;
    expect(preview).toEqual({
      previewed: true,
      timestamp: pickerHeld.timestamp,
      proof: pickerHeld.eventMessage,
    });
  });

  it("reads no line since the tap, or a stopped observer, as no preview, so the runner taps no more", async () => {
    vi.useFakeTimers();
    const previews = new PhonePickerPreviews();
    previews.receive(pickerHeld);
    // The earlier photo tap's preview is not the next tap's.
    const later = previews.preview(nextTapBegan);
    await vi.runAllTimersAsync();
    await expect(later).resolves.toMatchObject({
      previewed: false,
      reason: expect.stringContaining("No photo picker preview"),
    });
    const stopped = new PhonePickerPreviews();
    const pending = stopped.preview(photoTapBegan);
    stopped.close();
    await expect(pending).resolves.toMatchObject({
      previewed: false,
      reason: expect.stringContaining("observer stopped"),
    });
    stopped.receive(pickerHeld);
    await expect(stopped.preview(photoTapBegan)).resolves.toMatchObject({ previewed: false });
  });
});

// INF-2305: run 41545873258's iPad rest, simulator-live.log line 526342, and the home's press start.
// The narrow stream and the later kept log both omitted this response. The virtual Mac used UTC.
const broadPickerHeld =
  "2026-11-03 01:09:25.552 Df PhotosPicker[15243:18b70] [com.apple.UIKit:UICMILifecycle] performAllAnimations for animator: <_UIContextMenuAnimator: 0x111cc4090>";
const broadPhotoPress = Date.parse("2026-11-03T01:09:23.235Z");

describe("the existing broad log's Photos witness (INF-2305)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("delivers the real broad-only response through onLine while the other sources have none", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    const evidence = scratchDir("phone-preview-broad-");
    const children = new Set<ChildProcess>();
    const simulator = "FD8EB24A-6434-4959-842F-1E3AB3D1B415";
    let broad: PassThrough | undefined;
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      if (args.includes("compact")) broad = stdout;
      queueMicrotask(() => {
        if (args.includes("stream"))
          stdout.write("Filtering the log data using the requested predicate\n");
        else end(0); // The actual failure's later log show held no preview witness either.
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    const log = await observePhoneLog({
      device: simulator,
      env: {},
      evidence,
      children,
      predicate: 'process == "PhotosPicker"',
      onLine: observer.previewLine,
    });
    try {
      let answered = false;
      const read = observer.preview(broadPhotoPress).then((result) => {
        answered = true;
        return result;
      });
      const split = broadPickerHeld.indexOf("performAllAnimations");
      broad?.write(broadPickerHeld.slice(0, split));
      await Promise.resolve();
      expect(answered).toBe(false);
      broad?.write(`${broadPickerHeld.slice(split)}\n`);
      await vi.advanceTimersToNextTimerAsync();
      await expect(read).resolves.toEqual({
        previewed: true,
        timestamp: "2026-11-03 01:09:25.552+0000",
        proof: broadPickerHeld.slice(split),
      });
      expect(spawn.mock.calls.filter(([, args]) => args.includes("stream"))).toHaveLength(2);
    } finally {
      await observer.close();
      await log.close();
    }
    expect(children.size).toBe(0);
  });

  it("keeps process, message, press-time and deadline boundaries for broad records", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    const at = Date.parse("2026-11-03T01:09:25.552Z");
    // Controlled negatives derived from the captured response: a BackBoard sender, the different
    // completion message seen in run 41464279524, and a request that begins after this response.
    for (const [line, since] of [
      [broadPickerHeld.replace("PhotosPicker[", "backboardd["), broadPhotoPress],
      [broadPickerHeld.replace("performAllAnimations", "performAllCompletions"), broadPhotoPress],
      [broadPickerHeld, at + 1],
    ] as const) {
      const previews = new PhonePickerPreviews();
      const read = previews.preview(since);
      const original = new PhonePickerPreviews().preview(since);
      previews.receiveLine(line);
      await vi.advanceTimersToNextTimerAsync();
      expect(await read).toEqual(await original);
      expect(await read).toMatchObject({ previewed: false });
      previews.receiveLine(broadPickerHeld);
      expect(await read).toMatchObject({ previewed: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a real Photos preview omitted by the live observer (INF-2305)", () => {
  it("reads the same timestamped Photos witness once from the kept log", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async (_since: number, _signal: AbortSignal) => [restPickerHeld]);
    const previews = new PhonePickerPreviews(recover);
    await expect(previews.preview(restPhotoPress)).resolves.toEqual({
      previewed: true,
      timestamp: restPickerHeld.timestamp,
      proof: restPickerHeld.eventMessage,
    });
    expect(recover).toHaveBeenCalledExactlyOnceWith(restPhotoPress, expect.any(AbortSignal));
    expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
    // A cached live witness requires no kept-log read.
    const cached = vi.fn(async () => []);
    const live = new PhonePickerPreviews(cached);
    live.receive(restPickerHeld);
    await expect(live.preview(restPhotoPress)).resolves.toMatchObject({ previewed: true });
    expect(cached).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never accepts an older preview, another process, or a failed read as this press's proof", async () => {
    vi.useFakeTimers();
    for (const recover of [
      async () => [pickerHeld, listTap, pickerPreviewOpened],
      async () => {
        throw new Error("log show exited with 1");
      },
    ]) {
      const read = new PhonePickerPreviews(recover).preview(restPhotoPress);
      await vi.runAllTimersAsync();
      await expect(read).resolves.toMatchObject({ previewed: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original deadline and ignores records arriving after it", async () => {
    vi.useFakeTimers();
    let release!: (records: object[]) => void;
    const pending = new Promise<object[]>((resolve) => {
      release = resolve;
    });
    const recover = vi.fn((_since: number, _signal: AbortSignal) => pending);
    const previews = new PhonePickerPreviews(recover);
    const read = previews.preview(restPhotoPress);
    const unchanged = new PhonePickerPreviews().preview(restPhotoPress);
    await vi.advanceTimersToNextTimerAsync();
    expect(await read).toEqual(await unchanged);
    expect(await read).toMatchObject({ previewed: false });
    expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
    release([restPickerHeld]);
    await pending;
    expect(await read).toMatchObject({ previewed: false });
    // The expired read must not cache its late witness for a later caller either.
    recover.mockResolvedValue([]);
    const later = previews.preview(restPhotoPress);
    await vi.runAllTimersAsync();
    await expect(later).resolves.toMatchObject({ previewed: false });
    expect(recover).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["live", "stopped"])(
    "cancels the kept-log read when the %s observer settles",
    async (outcome) => {
      vi.useFakeTimers();
      let release!: (records: object[]) => void;
      const pending = new Promise<object[]>((resolve) => {
        release = resolve;
      });
      const recover = vi.fn((_since: number, _signal: AbortSignal) => pending);
      const previews = new PhonePickerPreviews(recover);
      const read = previews.preview(restPhotoPress);
      await Promise.resolve();
      if (outcome === "live") previews.receive(restPickerHeld);
      else previews.close();
      await expect(read).resolves.toMatchObject({ previewed: outcome === "live" });
      expect(recover.mock.calls[0]?.[1].aborted).toBe(true);
      release([restPickerHeld]);
      await pending;
      await expect(read).resolves.toMatchObject({ previewed: outcome === "live" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses the owned simulator's existing log reader for a missing preview", async () => {
    const evidence = scratchDir("phone-preview-recovery-");
    const children = new Set<ChildProcess>();
    const simulator = "E97A9867-4D42-4251-85CD-7785C10EDB3D";
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      queueMicrotask(() => {
        if (args.includes("stream")) {
          stdout.write("Filtering the log data using the registration predicate\n");
        } else {
          expect(args.slice(0, 5)).toEqual(["simctl", "spawn", simulator, "log", "show"]);
          expect(args[args.indexOf("--start") + 1]).toBe(logTime(new Date(restPhotoPress)));
          stdout.write(`${JSON.stringify(restPickerHeld)}\n`);
          end(0);
        }
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    await expect(observer.preview(restPhotoPress)).resolves.toMatchObject({
      previewed: true,
      proof: restPickerHeld.eventMessage,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    await observer.close();
    expect(children.size).toBe(0);
  });
});

// INF-2444: main run 41627462640's iPhone rest, the press PhoneJourney.swift:759 asked about. The test home's answer
// named the press's start; the narrow stream held no Photos record; the virtual Mac's kept log (17-xcrun.log) held the
// response and its two completions only as unreadable records. These are those compact lines and their ndjson form,
// which `log show --style ndjson` writes for an unreadable shared-cache message with its process, subsystem and
// category intact. Their neighbours are the same log's other unreadable Photos records of that second.
const unreadablePress = Date.parse("2026-11-03T12:56:07.809Z");
const unreadableLines = [
  "2026-11-03 12:56:09.811 Df PhotosPicker[28117:347f8] [com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
  "2026-11-03 12:56:10.551 Df PhotosPicker[28117:347f8] [com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
  "2026-11-03 12:56:10.552 Df PhotosPicker[28117:347f8] [com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
];
const unreadableNeighbours = [
  "2026-11-03 12:56:09.822 Df PhotosPicker[28117:347f8] [com.apple.UIKit:EventDispatch] <compose failure [shared UUID]>",
  "2026-11-03 12:56:09.840 Df PhotosPicker[28117:347f8] [com.apple.photos.ui:OneUp] <compose failure [shared UUID]>",
];
function keptRecord(line: string) {
  const [, time, process = "", subsystem, category, eventMessage] =
    /^(\S+ \S+) \S+ +([^[]+)\[[^\]]+\] \[([^:\]]+):([^\]]+)\] (.*)$/.exec(line) ?? [];
  return {
    processImagePath: photosPicker.replaceAll("PhotosPicker", process),
    timestamp: `${time}000+0000`,
    subsystem,
    category,
    formatString: "",
    eventMessage,
  };
}
const unreadableResponse = keptRecord(unreadableLines[0] ?? "");

describe("a Photos response the kept log holds without its words (INF-2444)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers the press from the kept log's first unreadable context menu record after it", async () => {
    vi.useFakeTimers();
    const recover = vi.fn(async (_since: number, _signal: AbortSignal) =>
      [...unreadableNeighbours, ...unreadableLines].map(keptRecord),
    );
    const read = new PhonePickerPreviews(recover).preview(unreadablePress);
    // The original deadline passes either way: only the kept records can make this answer true.
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual({
      previewed: true,
      timestamp: unreadableResponse.timestamp,
      proof: "[com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
    });
    expect(recover).toHaveBeenCalledExactlyOnceWith(unreadablePress, expect.any(AbortSignal));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the same unreadable record on the broad stream's compact line", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TZ", "UTC");
    const previews = new PhonePickerPreviews();
    const read = previews.preview(unreadablePress);
    for (const line of unreadableNeighbours) previews.receiveLine(line);
    await Promise.resolve();
    previews.receiveLine(unreadableLines[0] ?? "");
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual({
      previewed: true,
      timestamp: "2026-11-03 12:56:09.811+0000",
      proof: "[com.apple.UIKit:UICMILifecycle] <compose failure [shared UUID]>",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never takes another category, another process, a record before the press or another readable line", async () => {
    vi.useFakeTimers();
    // Controlled negatives derived from the captured response: the same record from the app, a press after all
    // three, the readable completion the same run's iPad logged in this category, and the record with no category.
    const cases: [object[], number][] = [
      [unreadableNeighbours.map(keptRecord), unreadablePress],
      [
        [keptRecord((unreadableLines[0] ?? "").replace("PhotosPicker[", "Infinitary["))],
        unreadablePress,
      ],
      [unreadableLines.map(keptRecord), phoneLogMilliseconds("2026-11-03 12:56:10.553000+0000")],
      [
        [
          {
            ...unreadableResponse,
            eventMessage:
              "performAllCompletions for animator: <_UIContextMenuAnimator: 0x1114ef510>",
          },
        ],
        unreadablePress,
      ],
      [[{ ...unreadableResponse, subsystem: undefined, category: undefined }], unreadablePress],
    ];
    for (const [records, since] of cases) {
      const read = new PhonePickerPreviews(async () => records).preview(since);
      await vi.runAllTimersAsync();
      await expect(read).resolves.toMatchObject({ previewed: false });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers the owned simulator's unreadable kept record to the press's answer", async () => {
    const evidence = scratchDir("phone-preview-unreadable-");
    const children = new Set<ChildProcess>();
    const simulator = "C199C565-5DE7-4346-BFB2-4C3BD7780141";
    spawn.mockImplementation((_command, args) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      function end(status: number | null) {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", status));
      }
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: vi.fn(() => {
          end(null);
          return true;
        }),
      });
      queueMicrotask(() => {
        if (args.includes("stream")) {
          stdout.write("Filtering the log data using the registration predicate\n");
        } else {
          for (const line of [...unreadableNeighbours, ...unreadableLines])
            stdout.write(`${JSON.stringify(keptRecord(line))}\n`);
          end(0);
        }
      });
      return child;
    });
    const observer = await observePhoneKeyboard({ simulator, env: {}, evidence, children });
    await expect(observer.preview(unreadablePress)).resolves.toMatchObject({
      previewed: true,
      timestamp: unreadableResponse.timestamp,
    });
    await observer.close();
    expect(children.size).toBe(0);
  });
});

// INF-1785 (the captain's choice "Confirm each change from the simulator's log, and set it once more only when the log
// proves the phone missed it"). Phone run 40788049243's join parts, at the compact log's millisecond times in that
// virtual Mac's UTC: the runner asked for the largest text size, the simulator saved it, and the iPhone's app read the
// old size a millisecond later and never again; the iPad's app read the new size in the save's own millisecond, logged
// before the save. Each part's `since` is when the runner sent that request, by its own network log. The app's own
// path is the one a local join run's log stream recorded for its reads.
const springBoard =
  "/Library/Developer/CoreSimulator/Volumes/iOS_23E244/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard";
const bridge =
  "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Platforms/iphoneos/usr/libexec/CoreSimulatorBridge";
const phoneApp =
  "/Users/kunchen/Library/Developer/CoreSimulator/Devices/AA9BA1FF-FC50-4657-B842-DDDDBBA53926/data/Containers/Bundle/Application/736BB5B4-7381-44F7-8A93-7A48061FE25E/Infinitary.app/Infinitary";
const iphoneLargestSaved = {
  processImagePath: bridge,
  timestamp: "2026-10-28 23:58:42.292000+0000",
  eventMessage:
    "Saved CategoryName: per-app = 0, category name = UICTContentSizeCategoryXXXL, usermode = 1",
};
const iphoneReadOld = {
  processImagePath: phoneApp,
  timestamp: "2026-10-28 23:58:42.293000+0000",
  eventMessage: "Read CategoryName: per-app = 0, category name = UICTContentSizeCategoryL",
};
const iphoneWebReadOld = {
  processImagePath: phoneApp,
  timestamp: "2026-10-28 23:58:42.295000+0000",
  eventMessage:
    "WebContent[8370] Read CategoryName: per-app = 0, category name = UICTContentSizeCategoryL",
};
// The iPhone's previous read, of the default size the runner set before.
const iphoneReadBefore = {
  processImagePath: phoneApp,
  timestamp: "2026-10-28 23:58:19.447000+0000",
  eventMessage: "Read CategoryName: per-app = 0, category name = UICTContentSizeCategoryL",
};
const iphoneLargestAsked = phoneLogMilliseconds("2026-10-28 23:58:42.017000+0000");
const ipadReadLargest = {
  processImagePath: phoneApp,
  timestamp: "2026-10-28 23:44:40.557000+0000",
  eventMessage: "Read CategoryName: per-app = 0, category name = UICTContentSizeCategoryXXXL",
};
const ipadLargestSaved = {
  processImagePath: bridge,
  timestamp: "2026-10-28 23:44:40.557000+0000",
  eventMessage:
    "Saved CategoryName: per-app = 0, category name = UICTContentSizeCategoryXXXL, usermode = 1",
};
const ipadLargestAsked = phoneLogMilliseconds("2026-10-28 23:44:40.203000+0000");
// Phone run 40792658138's iPhone join part: SpringBoard applied dark under two seconds after the runner asked, and
// light about 250 seconds after, past the journey's wait; its live log dropped the dark line, its own store kept it.
const darkApplied = {
  processImagePath: springBoard,
  timestamp: "2026-10-29 00:45:34.742000+0000",
  eventMessage: "Arbiter changing style from 1 to 2, notifying: 1",
};
const lightAppliedLate = {
  processImagePath: springBoard,
  timestamp: "2026-10-29 00:49:51.069000+0000",
  eventMessage: "Arbiter changing style from 2 to 1, notifying: 1",
};
const darkAsked = phoneLogMilliseconds("2026-10-29 00:45:32.972000+0000");
const lightAsked = phoneLogMilliseconds("2026-10-29 00:45:40.050000+0000");

describe("a display change's witness (INF-1785)", () => {
  it("confirms a text size only by the app's own read of it, even logged before the simulator's save", async () => {
    const displays = new PhoneDisplayChanges();
    displays.receive(ipadReadLargest);
    displays.receive(ipadLargestSaved);
    await expect(displays.textSize(ipadLargestAsked, "extra-extra-extra-large")).resolves.toEqual({
      outcome: "applied",
      timestamp: ipadReadLargest.timestamp,
      proof: ipadReadLargest.eventMessage,
    });
  });

  it("proves a missed text size only by the app's read of another size after the simulator logged the save", async () => {
    vi.useFakeTimers();
    const displays = new PhoneDisplayChanges();
    let outcome: unknown;
    const read = displays.textSize(iphoneLargestAsked, "extra-extra-extra-large").then((value) => {
      outcome = value;
    });
    // A read from before the runner asked, or the app's web page's read, says nothing about this save.
    displays.receive(iphoneReadBefore);
    displays.receive(iphoneWebReadOld);
    displays.receive(iphoneLargestSaved);
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    displays.receive(iphoneReadOld);
    await read;
    expect(outcome).toEqual({
      outcome: "missed",
      timestamp: iphoneReadOld.timestamp,
      proof: `${iphoneLargestSaved.eventMessage}; then ${iphoneReadOld.eventMessage}`,
    });
  });

  it("confirms an appearance only by SpringBoard changing to it, and reads no change as unknown", async () => {
    vi.useFakeTimers();
    const displays = new PhoneDisplayChanges();
    displays.receive(darkApplied);
    await expect(displays.appearance(darkAsked, "dark")).resolves.toEqual({
      outcome: "applied",
      timestamp: darkApplied.timestamp,
      proof: darkApplied.eventMessage,
    });
    // The earlier change to dark is no witness for light, and an appearance miss has no line to prove it.
    const light = displays.appearance(lightAsked, "light");
    await vi.runAllTimersAsync();
    await expect(light).resolves.toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("SpringBoard did not change to light"),
    });
    displays.receive(lightAppliedLate);
    await expect(displays.appearance(lightAsked, "light")).resolves.toMatchObject({
      outcome: "applied",
    });
    // A stopped observer is not a witness either, even with the proof already cached.
    const stopped = new PhoneDisplayChanges();
    stopped.receive(iphoneLargestSaved);
    stopped.receive(iphoneReadOld);
    stopped.close();
    await expect(
      stopped.textSize(iphoneLargestAsked, "extra-extra-extra-large"),
    ).resolves.toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("observer stopped"),
    });
  });

  // INF-1786, the captain's choice "Wait for SpringBoard's own line, up to the request's 8-minute limit".
  it("waits for SpringBoard's own line as late as run 40792658138's light, and no longer than the journey's request", async () => {
    vi.useFakeTimers({ now: lightAsked });
    const displays = new PhoneDisplayChanges();
    const until = phoneDisplayDeadline(lightAsked);
    let outcome: unknown;
    const light = displays.appearance(lightAsked, "light", until).then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(
      phoneLogMilliseconds(lightAppliedLate.timestamp) - Date.now(),
    );
    expect(outcome).toBeUndefined();
    displays.receive(lightAppliedLate);
    await light;
    expect(outcome).toEqual({
      outcome: "applied",
      timestamp: lightAppliedLate.timestamp,
      proof: lightAppliedLate.eventMessage,
    });
    // A line that never comes is unknown at the deadline, before the journey's own request ends.
    const never = displays.appearance(Date.now(), "dark", phoneDisplayDeadline());
    await vi.advanceTimersByTimeAsync(phoneDisplayDeadline() - Date.now() - 1);
    await expect(Promise.race([never, Promise.resolve("waiting")])).resolves.toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    await expect(never).resolves.toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("SpringBoard did not change to dark"),
    });
    expect(until).toBeLessThan(lightAsked + waitCap(PHONE_DISPLAY_REQUEST_BUDGET_MS));
  });

  it("sets the text size once more only on a proven miss, and fails after two", async () => {
    vi.useFakeTimers();
    // Each save is answered by the readings of one real save, the iPhone's missed one or the iPad's read one, on a
    // clock set to when the runner asked for it.
    const missed: [number, object[]] = [iphoneLargestAsked, [iphoneLargestSaved, iphoneReadOld]];
    const read: [number, object[]] = [ipadLargestAsked, [ipadReadLargest, ipadLargestSaved]];
    const unread: [number, object[]] = [iphoneLargestAsked, [iphoneLargestSaved]];
    let saves = 0;
    const change = (answers: [number, object[]][]) => {
      saves = 0;
      const pending = [...answers];
      const next = () => {
        const answer = pending.shift();
        if (answer) vi.setSystemTime(answer[0]);
        return answer;
      };
      let answer = next();
      const displays = new PhoneDisplayChanges();
      return changePhoneTextSize(
        "extra-extra-extra-large",
        async () => {
          for (const record of answer?.[1] ?? []) displays.receive(record);
          saves += 1;
          answer = next();
        },
        (since) => displays.textSize(since, "extra-extra-extra-large"),
      );
    };
    await expect(change([missed, read])).resolves.toMatchObject([
      { outcome: "missed" },
      { outcome: "applied" },
    ]);
    expect(saves).toBe(2);
    await expect(change([missed, missed])).rejects.toThrow(
      "The app read the old text size after both of the simulator's saves",
    );
    expect(saves).toBe(2);
    // An unproven save, such as one whose read the log dropped, is set only once.
    const unproven = change([unread, read]);
    await vi.runAllTimersAsync();
    await expect(unproven).resolves.toMatchObject([{ outcome: "unknown" }]);
    expect(saves).toBe(1);
  });

  // INF-2052: PR #757's rerun spent nine minutes of the iPad's join part on the witness of a size it already had.
  it("sets a text size the part already asked for once more and answers unchanged without waiting for a witness", async () => {
    let saves = 0;
    const confirm = vi.fn((_since: number) => new Promise<never>(() => {}));
    await expect(
      changePhoneTextSize(
        "large",
        async () => {
          saves += 1;
        },
        confirm,
        "large",
      ),
    ).resolves.toEqual([{ outcome: "unchanged" }]);
    expect(saves).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    // A new size still waits for its witness: the iPad's real save of the largest size, on a clock set to its asking.
    vi.useFakeTimers();
    vi.setSystemTime(ipadLargestAsked);
    const displays = new PhoneDisplayChanges();
    const witnessed = vi.fn((since: number) => displays.textSize(since, "extra-extra-extra-large"));
    const changed = changePhoneTextSize(
      "extra-extra-extra-large",
      async () => {
        for (const record of [ipadReadLargest, ipadLargestSaved]) displays.receive(record);
      },
      witnessed,
      "large",
    );
    await expect(changed).resolves.toEqual([
      {
        outcome: "applied",
        timestamp: ipadReadLargest.timestamp,
        proof: ipadReadLargest.eventMessage,
      },
    ]);
    expect(witnessed).toHaveBeenCalledTimes(1);
  });

  it("answers display changes from the same renewed subscription as the chords", async () => {
    const evidence = scratchDir("phone-keyboard-display-");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => {
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      }),
    });
    spawn.mockImplementation(() => {
      queueMicrotask(() =>
        stdout.write("Filtering the log data using the registration predicate\n"),
      );
      return child;
    });
    const children = new Set<ChildProcess>();
    const observer = await observePhoneKeyboard({
      simulator: "73A1ACE6-4598-4DFC-AA31-2A09D6081FF3",
      env: {},
      evidence,
      children,
    });
    const dark = observer.appearance(darkAsked, "dark");
    const size = observer.textSize(iphoneLargestAsked, "extra-extra-extra-large");
    for (const record of [darkApplied, iphoneLargestSaved, iphoneReadOld])
      stdout.write(`${JSON.stringify(record)}\n`);
    await expect(dark).resolves.toMatchObject({ outcome: "applied" });
    await expect(size).resolves.toMatchObject({ outcome: "missed" });
    await observer.close();
    expect(children.size).toBe(0);
  });
});

describe("the owned simulator's hardware keyboard during a chord's acknowledgement wait", () => {
  const simulator = "A9EEAD2F-B238-4612-9A9C-250E64BC7E52";

  it("attaches it before the wait and detaches it after, also when no registration arrives", async () => {
    const commands: string[][] = [];
    const run = async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      return "";
    };
    await expect(
      withPhoneHardwareKeyboard(run, simulator, async () => {
        expect(commands).toEqual([["xcrun", ...hardwareKeyboardArguments(simulator, true)]]);
        // The refusal a captured iPhone run produced once its app had launched after the keyboard detached.
        throw new Error("No backboard registration for app 61016, cmd|shft:k");
      }),
    ).rejects.toThrow("No backboard registration");
    expect(commands).toEqual([
      ["xcrun", ...hardwareKeyboardArguments(simulator, true)],
      ["xcrun", ...hardwareKeyboardArguments(simulator, false)],
    ]);
    const states = commands.map((command) => {
      const [xcrun, simctl, spawn, owned, tool, set, key, value, post, posted] = command;
      expect([xcrun, simctl, spawn, owned, tool, set, post]).toEqual([
        "xcrun",
        "simctl",
        "spawn",
        simulator,
        "notifyutil",
        "-s",
        "-p",
      ]);
      expect(key).toBe(PHONE_HARDWARE_KEYBOARD_STATE);
      expect(posted).toBe(PHONE_HARDWARE_KEYBOARD_STATE);
      return Number(value);
    });
    // GraphicsServices reads the low byte as the attached flag; backboardd wrote 8449 and 8448 for
    // XCTest's own US keyboard (country code 33) connecting and disconnecting in the captured runs.
    expect(states.map((state) => state & 0xff)).toEqual([1, 0]);
    expect(states.map((state) => state >> 8)).toEqual([33, 33]);
  });

  it("returns the witness the wait produced once the keyboard is detached again", async () => {
    const commands: string[] = [];
    const run = async (_command: string, args: string[]) => {
      commands.push(args[6] ?? "");
      return "";
    };
    const witness = { pid: 7425, token: "0x9c03bb08", timestamp: "", key: "i", modifiers: ["cmd"] };
    await expect(withPhoneHardwareKeyboard(run, simulator, async () => witness)).resolves.toBe(
      witness,
    );
    expect(commands).toEqual([String((33 << 8) | 1), String(33 << 8)]);
  });
});

// INF-1799: phone run 40817473942's iPhone join part, in its kept simulator log (the part's failure collection). The
// runner asked for the Large text size at 04:35:46.365 by its own log; SpringBoard changed to dark, the simulator saved
// Large and the app read Large 587 ms later, but the runner's live log stream delivered no read of it.
const keptDark = {
  processImagePath: springBoard,
  timestamp: "2026-10-29 04:35:46.412000+0000",
  eventMessage: "Arbiter changing style from 1 to 2, notifying: 1",
};
const keptLargeSaved = {
  processImagePath: bridge,
  timestamp: "2026-10-29 04:35:46.904000+0000",
  eventMessage:
    "Saved CategoryName: per-app = 0, category name = UICTContentSizeCategoryL, usermode = 1",
};
const keptLargeRead = {
  processImagePath: phoneApp,
  timestamp: "2026-10-29 04:35:46.952000+0000",
  eventMessage: "Read CategoryName: per-app = 0, category name = UICTContentSizeCategoryL",
};
const largeAsked = phoneLogMilliseconds("2026-10-29 04:35:46.365000+0000");

/** A `log` child: its stream announces its filter; a `log show` writes its records and exits, or never answers. */
function logChild(records: object[] | "hangs" | "stream") {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(() => {
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    }),
  });
  queueMicrotask(() => {
    if (records === "stream")
      stdout.write("Filtering the log data using the registration predicate\n");
    else if (records !== "hangs") {
      stdout.once("end", () => queueMicrotask(() => child.emit("close", 0, null)));
      for (const record of records) stdout.write(`${JSON.stringify(record)}\n`);
      stdout.end();
      stderr.end();
    }
  });
  return child;
}

describe("a display witness the live log dropped (INF-1799)", () => {
  const clockKey = Symbol.for("infinitary.loadClock");
  afterEach(() => {
    delete (globalThis as { [clockKey]?: unknown })[clockKey];
  });

  it("reads the simulator's kept log for the app's read before it answers unknown", async () => {
    vi.useFakeTimers({ now: largeAsked });
    const stream = logChild("stream");
    const kept = logChild([keptDark, keptLargeSaved, keptLargeRead]);
    spawn.mockReturnValueOnce(stream).mockReturnValueOnce(kept);
    const observer = await observePhoneKeyboard({
      simulator: "73A1ACE6-4598-4DFC-AA31-2A09D6081FF3",
      env: {},
      evidence: scratchDir("phone-keyboard-kept-"),
      children: new Set<ChildProcess>(),
    });
    const size = observer.textSize(largeAsked, "large");
    for (const record of [keptDark, keptLargeSaved])
      stream.stdout.write(`${JSON.stringify(record)}\n`);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(size).resolves.toEqual({
      outcome: "applied",
      timestamp: keptLargeRead.timestamp,
      proof: keptLargeRead.eventMessage,
    });
    expect(spawn).toHaveBeenLastCalledWith(
      "xcrun",
      expect.arrayContaining(["73A1ACE6-4598-4DFC-AA31-2A09D6081FF3", "log", "show", "--start"]),
      expect.anything(),
    );
    await observer.close();
  });

  it("answers unknown before the journey's display request ends, on a host as starved as that run's", async () => {
    vi.useFakeTimers({ now: largeAsked });
    // That run's runner counted its witness's 30 s of load time in no less than 600 s of wall time.
    const processors = 4;
    const clock = startLoadClock(
      () => Date.now(),
      () => 20 * processors,
      processors,
    );
    (globalThis as { [clockKey]?: unknown })[clockKey] = clock;
    const stream = logChild("stream");
    // The worst case: the kept log lacks the read too and never answers.
    const kept = logChild("hangs");
    spawn.mockReturnValueOnce(stream).mockReturnValueOnce(kept);
    const observer = await observePhoneKeyboard({
      simulator: "73A1ACE6-4598-4DFC-AA31-2A09D6081FF3",
      env: {},
      evidence: scratchDir("phone-keyboard-starved-"),
      children: new Set<ChildProcess>(),
    });
    // The display control starts once the journey's request reaches it, so that request ends no earlier than this.
    const started = Date.now();
    const journeyRequestEnds = started + waitCap(PHONE_DISPLAY_REQUEST_BUDGET_MS);
    // The simulator's two writes took until the save in that run.
    vi.setSystemTime(phoneLogMilliseconds(keptLargeSaved.timestamp));
    const size = observer
      .textSize(started, "large", phoneDisplayDeadline(started))
      .then((outcome) => ({ outcome, at: Date.now() }));
    for (const record of [keptDark, keptLargeSaved])
      stream.stdout.write(`${JSON.stringify(record)}\n`);
    await vi.advanceTimersByTimeAsync(journeyRequestEnds - Date.now());
    const answered = await Promise.race([size, Promise.resolve(undefined)]);
    expect(answered?.outcome).toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("the app did not read UICTContentSizeCategoryL"),
    });
    expect(answered?.at).toBeLessThan(journeyRequestEnds);
    expect(kept.kill).toHaveBeenCalled();
    clock.stop();
    await observer.close();
  });
});

// INF-2076: phone run 41129165054's iPad cards part, the join link field's tap, which the runner began at this time
// in that virtual Mac's UTC and asked about 6.9 seconds later. Its live log held none of the tap's backboardd lines,
// its kept log took over a minute to read, and the runner's own outcome request ended at its 10-minute cap before the
// home's unknown reached it. INF-1927's untouched-main run 41006083356 failed the same way after the card pager's tap.
const joinLinkTapBegan = Date.parse("2026-10-30T23:13:59.839Z");
const joinLinkAsked = Date.parse("2026-10-30T23:14:06.750Z");

describe("a tap's outcome on a host too starved to read its witness (INF-2076)", () => {
  const clockKey = Symbol.for("infinitary.loadClock");
  afterEach(() => {
    delete (globalThis as { [clockKey]?: unknown })[clockKey];
  });

  it("answers unknown before the runner's outcome request ends, so the runner reads it and taps nothing more", async () => {
    vi.useFakeTimers({ now: joinLinkAsked });
    // That run's runner counted less than its request's 40 seconds of load time in 600 seconds of wall time, and the
    // home's 30-second witness had not answered by then either. The worst case: the home's load clock counts nothing,
    // as a stalled process's does, so only the wall caps end its waits.
    const clock = startLoadClock(
      () => Date.now(),
      () => Number.POSITIVE_INFINITY,
    );
    (globalThis as { [clockKey]?: unknown })[clockKey] = clock;
    const stream = logChild("stream");
    const kept = logChild("hangs");
    spawn.mockReturnValueOnce(stream).mockReturnValueOnce(kept);
    const observer = await observePhoneKeyboard({
      simulator: "4B7F0C2E-3D1A-4E8B-9F6C-2A5D8E1B7C30",
      env: {},
      evidence: scratchDir("phone-touch-starved-"),
      children: new Set<ChildProcess>(),
    });
    // The home reads the tap once the runner's request reaches it, so that request ends no later than this.
    const asked = Date.now();
    const runnerRequestEnds = asked + waitCap(PHONE_TOUCH_REQUEST_BUDGET_MS);
    const read = observer.touch(joinLinkTapBegan).then((outcome) => ({ outcome, at: Date.now() }));
    await vi.advanceTimersByTimeAsync(runnerRequestEnds - Date.now());
    const answered = await Promise.race([read, Promise.resolve(undefined)]);
    expect(answered?.outcome).toEqual({
      outcome: "unknown",
      reason:
        "No touch screen witness since 2026-10-30T23:13:59.839Z; the simulator's kept log could not be read: it took over 60 seconds",
    });
    expect(answered?.at).toBeLessThan(runnerRequestEnds);
    expect(kept.kill).toHaveBeenCalled();
    clock.stop();
    await observer.close();
  });
});

// INF-2625's phone guard: the journey's display requests wait `displayBudget` seconds, the budget this mirrors
// (INF-1786); a split of PhoneJourney may move it into any of the journey's files, and it stays the one value.
describe("the journey's display request budget", () => {
  it("is the budget PhoneJourney gives its display requests", () => {
    const journey = "ios/Infinitary/InfinitaryUITests";
    const budgets = readdirSync(journey)
      .filter((file) => file.endsWith(".swift"))
      .flatMap((file) => [
        ...readFileSync(join(journey, file), "utf8").matchAll(
          /\blet displayBudget: TimeInterval = ([\d_]+)\b/g,
        ),
      ])
      .map((match) => Number((match[1] as string).replaceAll("_", "")));
    expect(budgets).toEqual([PHONE_DISPLAY_REQUEST_BUDGET_MS / 1000]);
  });
});
