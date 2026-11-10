import { expect, it, vi } from "vitest";
import {
  decodeFixtureReply,
  FIXTURE_AREAS,
  FIXTURE_COMMANDS,
  fixtureControls,
} from "./fixtures/native-secrets/control";

// Intent: the old signed fixture closed on an unsupported Recovery control, but
// its client exited successfully with no reply. Refusal or loss must stay explicit.
it("distinguishes an answered control from refusal, missing and interrupted replies", async () => {
  const controls = fixtureControls({
    confirming: () => true,
    status: async () => ({ availability: "available", confirming: true }),
    perform: vi.fn(),
  });
  expect(decodeFixtureReply(JSON.stringify(await controls("status")))).toEqual({
    value: { availability: "available", confirming: true },
    refused: false,
  });
  expect(decodeFixtureReply(JSON.stringify(await controls("capture"))).refused).toBe(true);
  for (const reply of ["", " ", '{"selected":', "null", "[]", "true"])
    expect(() => decodeFixtureReply(reply)).toThrow();
});

// Intent: INF-1109's approved app-owned fixture controls must not broaden desktop
// access or automate a person's native confirmation. Only the surface stands in.
it("refuses evaluation, secret entry, arbitrary clicks and authentication controls", async () => {
  const perform = vi.fn();
  const controls = fixtureControls({ confirming: () => false, status: async () => ({}), perform });
  for (const command of [
    "evaluate",
    "type password",
    "click 20 30",
    "authenticate",
    "capture\n",
    "constructor",
    "__proto__",
  ])
    expect(await controls(command)).toHaveProperty("refused");
  expect(perform).not.toHaveBeenCalled();
});

// Intent: the signed proof could not reach Recovery without a general-input control.
it("dispatches the fixed Secrets views but refuses arbitrary selection", async () => {
  const perform = vi.fn(async (area: string) => ({ selected: area }));
  const controls = fixtureControls({ confirming: () => false, status: async () => ({}), perform });
  for (const area of FIXTURE_AREAS) expect(await controls(area)).toEqual({ selected: area });
  expect(await controls("select #password recovery")).toHaveProperty("refused");
  expect(await controls("recovery\nrestore")).toHaveProperty("refused");
  expect(perform.mock.calls.map(([command]) => command)).toEqual([...FIXTURE_AREAS]);
});

it("leaves only metadata status available during native confirmation", async () => {
  const perform = vi.fn();
  const controls = fixtureControls({
    confirming: () => true,
    status: async () => ({ availability: "available", state: "waiting" }),
    perform,
  });
  for (const command of FIXTURE_COMMANDS.filter((one) => one !== "status"))
    expect(await controls(command)).toHaveProperty("refused");
  expect(await controls("status")).toEqual({ availability: "available", state: "waiting" });
  expect(perform).not.toHaveBeenCalled();
});

it("does not queue a second action or capture behind an unfinished use", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const perform = vi.fn(async () => {
    await held;
    return { finished: true };
  });
  const controls = fixtureControls({
    confirming: () => false,
    status: async () => ({ state: "waiting" }),
    perform,
  });
  const pending = controls("allow-once");
  expect(await controls("capture")).toHaveProperty("refused");
  expect(await controls("allow-once")).toHaveProperty("refused");
  expect(await controls("status")).toEqual({ state: "waiting" });
  release();
  expect(await pending).toEqual({ finished: true });
  expect(perform).toHaveBeenCalledTimes(1);
});

it("releases its control turn after an error but never repeats the action", async () => {
  const perform = vi
    .fn()
    .mockRejectedValueOnce(new Error("interrupted"))
    .mockResolvedValue({ captured: true });
  const controls = fixtureControls({ confirming: () => false, status: async () => ({}), perform });
  await expect(controls("backup")).rejects.toThrow("interrupted");
  expect(await controls("capture")).toEqual({ captured: true });
  expect(perform.mock.calls.map(([command]) => command)).toEqual(["backup", "capture"]);
});
