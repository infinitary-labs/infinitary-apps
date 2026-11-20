import { describe, expect, it } from "vitest";
import { ACTIONS } from "./actions";
import type { DeviceView } from "./devices";
import { KEPT_ITEM_PREFIX, type KeptJobView } from "./keptJobs";
import { SECRETS_AREAS } from "./secrets";
import type { DeviceSignIns } from "./signIns";

/**
 * The first mate's cards for the acts in Settings that stay the captain's
 * own click (INF-5326's approved plan, piece 2): each card's button opens
 * the exact place, and none is offered where its act does not apply.
 */

const HERE = { platform: "darwin" };
/** Another Mac that runs work, added by its address, in reach on this version. */
const MINI: DeviceView = {
  id: "mini",
  kind: "work",
  name: "Mac mini",
  pairedAt: 1,
  user: "sam",
  onThisMac: false,
  inReach: true,
  remoteLogin: "sam@mini.local",
  ssh: { state: "connected" },
  tasks: 0,
  runs: [],
};
/** A Mac that only controls the first mate. */
const AIR: DeviceView = { id: "air", kind: "view", name: "MacBook Air", pairedAt: 1 };

function offer(action: keyof typeof ACTIONS, value: unknown, current: unknown, also?: unknown) {
  const make = ACTIONS[action].offer;
  if (!make) throw new Error(`${action} offers no card`);
  return make(ACTIONS[action].value.parse(value) as Record<string, unknown>, current, {
    ...HERE,
    ...(also === undefined ? {} : { also }),
  });
}

describe("cards for a computer's own acts", () => {
  it("opens the computer's own row for its address, a move and a copy", () => {
    for (const action of ["device-change-address", "home-move", "standby-keep"] as const) {
      expect(offer(action, { deviceId: MINI.id }, [AIR, MINI], { standbys: [] })).toMatchObject({
        label: "Open Mac mini",
        arrival: { item: MINI.id },
      });
    }
    // INF-5355's review, share-checks-and-keep-card: moving the first mate and keeping a copy are
    // in the row only on the first mate's own computer, so their cards say so.
    expect(offer("home-move", { deviceId: MINI.id }, [MINI]).arrival).toEqual({
      item: MINI.id,
      fromHome: true,
    });
    expect(offer("device-change-address", { deviceId: MINI.id }, [MINI]).arrival).toEqual({
      item: MINI.id,
    });
  });

  // The same review: a card opens a row only where the row shows that act.
  it("offers none where the computer's row shows no such control", () => {
    const left: DeviceView = { ...MINI, ssh: { state: "stopped", reason: "other-home" } };
    for (const action of ["device-change-address", "home-move", "standby-keep"] as const)
      expect(() => offer(action, { deviceId: MINI.id }, [left], { standbys: [] })).toThrow(
        "another first mate",
      );
    expect(() =>
      offer("device-change-address", { deviceId: MINI.id }, [{ ...MINI, ssh: undefined }]),
    ).toThrow("does not reach Mac mini by its address");
    const copying = {
      standbys: [{ deviceId: MINI.id, state: "in-sync" as const, copyAt: 1 }],
    };
    expect(() => offer("standby-keep", { deviceId: MINI.id }, [MINI], copying)).toThrow(
      "keeps a copy already",
    );
  });

  it("offers none for a Mac that only controls the first mate, or one being removed", () => {
    for (const action of ["device-change-address", "home-move", "standby-keep"] as const) {
      expect(() => offer(action, { deviceId: AIR.id }, [AIR, MINI])).toThrow("runs no work");
      expect(() =>
        offer(action, { deviceId: MINI.id }, [{ ...MINI, removal: "when-back" }]),
      ).toThrow("being removed");
    }
  });

  it("changes an address only for a computer added by one", () => {
    const byCommand = { ...MINI, remoteLogin: undefined };
    expect(() => offer("device-change-address", { deviceId: MINI.id }, [byCommand])).toThrow(
      "not added by its address",
    );
  });

  it("moves the first mate only to a computer in reach on this version", () => {
    expect(() => offer("home-move", { deviceId: MINI.id }, [{ ...MINI, inReach: false }])).toThrow(
      "out of reach",
    );
    expect(() =>
      offer("home-move", { deviceId: MINI.id }, [
        {
          ...MINI,
          otherVersion: { app: "0.0.1", than: "older", takesWork: true, updateBy: "remote-login" },
        },
      ]),
    ).toThrow("another version");
  });
});

describe("a computer's own GitHub sign-in", () => {
  const GITHUB = { host: "github.com", name: "GitHub" };
  const computer = (over: Partial<DeviceSignIns> = {}): DeviceSignIns => ({
    deviceId: "mini",
    name: "Mac mini",
    onThisMac: false,
    reach: "in-reach",
    signIns: { providers: [], accounts: [], quota: null, forges: { signIns: [], hosts: [GITHUB] } },
    ...over,
  });

  it("starts that computer's sign-in in Integrations", () => {
    expect(offer("device-forge-sign-in", { deviceId: "mini" }, [computer()])).toMatchObject({
      label: "Sign in",
      arrival: { forgeSignInOn: { deviceId: "mini", host: "github.com" } },
    });
  });

  it("offers none to a computer out of reach or already signed in", () => {
    expect(() =>
      offer("device-forge-sign-in", { deviceId: "mini" }, [computer({ reach: "out-of-reach" })]),
    ).toThrow("not connected for work");
    const signedIn = computer({
      signIns: {
        providers: [],
        accounts: [],
        quota: null,
        forges: {
          signIns: [{ ...GITHUB, login: "octo", state: "ok", since: 1 }],
          hosts: [GITHUB],
        },
      },
    });
    expect(() => offer("device-forge-sign-in", { deviceId: "mini" }, [signedIn])).toThrow(
      "already signed in",
    );
  });
});

describe("the other acts that stay the captain's", () => {
  it("asks which of two first mates to keep only while two answer", () => {
    const two = { standbys: [], twoHomes: { deviceId: "mini", name: "Mac mini" } };
    expect(offer("keep-home", {}, two)).toMatchObject({ label: "Open Devices" });
    expect(offer("keep-home", {}, two).arrival).toEqual({ fromHome: true });
    expect(() => offer("keep-home", {}, { standbys: [] })).toThrow("Only one first mate");
  });

  it("opens a kept job in Automation to forget it, only once its remove did not finish", () => {
    const job: KeptJobView = {
      id: "inf-12-1@mini",
      label: "Nightly backup",
      computer: "mini",
      computerName: "Mac mini",
      account: "sam",
      task: "task-1",
      key: "INF-12",
      at: 1,
      removeFailed: { at: 2, outcome: "unreachable" },
    };
    expect(offer("kept-job-forget", { id: job.id }, { jobs: [job] })).toMatchObject({
      label: "Open Automation",
      arrival: { section: "automation", item: `${KEPT_ITEM_PREFIX}${job.id}` },
    });
    const { removeFailed: _, ...running } = job;
    expect(() => offer("kept-job-forget", { id: job.id }, { jobs: [running] })).toThrow(
      "kept-job-remove",
    );
  });

  it("opens each page of Secrets by name", () => {
    for (const area of SECRETS_AREAS) {
      expect(offer("secrets-page", { page: area.value }, null)).toMatchObject({
        title: `Open ${area.label} in Secrets`,
        arrival: { section: "secrets", item: area.value, fromHome: true },
      });
    }
  });

  it("makes a phone's link from its own card", () => {
    expect(offer("device-invite", { how: "phone" }, [])).toMatchObject({
      title: "Connect your phone",
      label: "Make a link",
      arrival: { phone: true },
    });
  });
});
