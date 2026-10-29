import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
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
  PhoneDisplayChanges,
  PhoneKeyRegistrations,
  PhonePickerPreviews,
  PhoneTouchOutcomes,
  phoneApplicationPid,
  phoneDisplayDeadline,
  phoneLogMilliseconds,
  withPhoneHardwareKeyboard,
} from "./helpers/phoneKeyboard";
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

describe("a tap's touch screen witness (INF-1477)", () => {
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
