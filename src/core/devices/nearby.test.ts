import { NEARBY_LEASE_MS, type NearbyMacsView } from "@shared/nearbyMacs";
import { describe, expect, it } from "vitest";
import type { DnsSdRun } from "./dnsSd";
import { NearbyMacs, POLICY_DENIED, readBrowseLine, readResolveLine } from "./nearby";

/**
 * Macs nearby (docs/devices.md, "Macs nearby") against a stand-in for
 * macOS's dns-sd that answers in memory: the lines are the ones dns-sd
 * printed on a Mac on 2026-10-08, with a name that holds a curly quote.
 */

const BROWSED = [
  "Browsing for _ssh._tcp.local.",
  "DATE: ---Thu 08 Oct 2026---",
  "19:24:47.007  ...STARTING...",
  "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name",
  "19:24:47.007  Add        3  14 local.               _ssh._tcp.           Kun’s Mac mini",
  "19:24:47.007  Add        3   1 local.               _ssh._tcp.           Kun’s MacBook Pro",
  "19:24:47.007  Add        2  14 local.               _ssh._tcp.           Kun’s MacBook Pro",
];
const reached = (name: string, at: string) =>
  `19:25:28.898  ${name.replaceAll(" ", "\\032")}._ssh._tcp.local. can be reached at ${at}.:22 (interface 14)`;

type Running = {
  args: readonly string[];
  line: (text: string) => void;
  ended: (finished: boolean) => void;
  stopped: boolean;
};

/** A dns-sd in memory: each run is kept, to print to and end. */
function standIn() {
  const runs: Running[] = [];
  const run: DnsSdRun = (args, heard) => {
    const running: Running = { args, ...heard, stopped: false };
    runs.push(running);
    return {
      stop: () => {
        running.stopped = true;
      },
    };
  };
  const browse = () => {
    const found = runs.findLast((each) => each.args.includes("-B") && !each.stopped);
    if (!found) throw new Error("Nothing is browsing.");
    return found;
  };
  const lookup = (name: string) => {
    const found = runs.find((each) => each.args.includes("-L") && each.args.at(-3) === name);
    if (!found) throw new Error(`Nobody asked ${name}.`);
    return found;
  };
  return { run, runs, browse, lookup };
}

/** A clock that moves only when told. */
function clock() {
  let now = 0;
  const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    later: (ms: number, fire: () => void) => {
      const timer = { at: now + ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Moves the clock on `ms`, firing each timer that came due. */
    pass: (ms: number) => {
      now += ms;
      for (const timer of timers.filter((each) => each.at <= now && !each.cancelled)) {
        timer.cancelled = true;
        timer.fire();
      }
    },
  };
}

function nearby(
  options: { own?: () => Promise<readonly string[]>; user?: string; run?: DnsSdRun | null } = {},
) {
  const dnsSd = standIn();
  const time = clock();
  const told: NearbyMacsView[] = [];
  const macs = new NearbyMacs({
    run: options.run === undefined ? dnsSd.run : options.run,
    ownNames: options.own ?? (async () => ["kuns-macbook-pro.local"]),
    user: options.user ?? "kun",
    changed: (view) => told.push(view),
    later: time.later,
  });
  return { macs, dnsSd, time, told };
}

/** Lets the own-names promise settle. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("reading dns-sd", () => {
  it("reads each Mac announced or gone, with its interface, and an error's code", () => {
    expect(readBrowseLine(BROWSED[4] ?? "")).toEqual({
      kind: "add",
      name: "Kun’s Mac mini",
      interfaceIndex: 14,
    });
    expect(
      readBrowseLine(
        "19:30:01.120  Rmv        0   1 local.               _ssh._tcp.           Kun’s MacBook Pro",
      ),
    ).toEqual({ kind: "remove", name: "Kun’s MacBook Pro", interfaceIndex: 1 });
    expect(readBrowseLine(`19:30:01.120  Error code ${POLICY_DENIED}`)).toEqual({
      kind: "error",
      code: POLICY_DENIED,
    });
    expect(readBrowseLine("DNSService call failed -65563")).toEqual({
      kind: "error",
      code: -65563,
    });
    for (const header of BROWSED.slice(0, 4)) expect(readBrowseLine(header)).toBeNull();
  });

  it("never reads a Mac's own name as an error", () => {
    expect(
      readBrowseLine(
        "19:24:47.007  Add        2  14 local.               _ssh._tcp.           Error code -65570",
      ),
    ).toEqual({ kind: "add", name: "Error code -65570", interfaceIndex: 14 });
  });

  it("reads a Mac's name on this network, and nothing an address could not carry", () => {
    expect(readResolveLine(reached("Kun’s Mac mini", "Kuns-Mac-mini.local"))).toBe(
      "Kuns-Mac-mini.local",
    );
    expect(readResolveLine(reached("Odd", "-oProxyCommand=x"))).toBeNull();
    expect(readResolveLine("Lookup Kun’s Mac mini._ssh._tcp.local.")).toBeNull();
  });
});

describe("Macs nearby", () => {
  it("lists each Mac that answers by its own name, with the user, and never this Mac", async () => {
    const { macs, dnsSd } = nearby();
    expect(macs.ask(true)).toEqual({ state: "looking", user: "kun", macs: [] });
    const browse = dnsSd.browse();
    // Each run ends by itself, so nothing listens long after Firstmate stopped.
    expect(browse.args).toEqual(["-t", "75", "-B", "_ssh._tcp", "local."]);
    for (const line of BROWSED) browse.line(line);
    // Each Mac is asked its name once, however many interfaces announce it.
    expect(dnsSd.runs.filter((run) => run.args.includes("-L")).map((run) => run.args)).toEqual([
      ["-t", "5", "-L", "Kun’s Mac mini", "_ssh._tcp", "local."],
      ["-t", "5", "-L", "Kun’s MacBook Pro", "_ssh._tcp", "local."],
    ]);
    dnsSd.lookup("Kun’s Mac mini").line(reached("Kun’s Mac mini", "Kuns-Mac-mini.local"));
    dnsSd.lookup("Kun’s MacBook Pro").line(reached("Kun’s MacBook Pro", "Kuns-MacBook-Pro.local"));
    await settle();
    expect(macs.view()).toEqual({
      state: "looking",
      user: "kun",
      macs: [{ name: "Kun’s Mac mini", at: "Kuns-Mac-mini.local" }],
    });
    // A name asked is not asked on: each lookup ends once it answered.
    expect(dnsSd.runs.filter((run) => run.args.includes("-L")).every((run) => run.stopped)).toBe(
      true,
    );
  });

  it("lists nothing until it knows this Mac's own names", async () => {
    let tell: (names: readonly string[]) => void = () => {};
    const own = new Promise<readonly string[]>((resolve) => {
      tell = resolve;
    });
    const { macs, dnsSd } = nearby({ own: () => own });
    macs.ask(true);
    dnsSd.browse().line(BROWSED[4] ?? "");
    dnsSd.browse().line(BROWSED[5] ?? "");
    dnsSd.lookup("Kun’s Mac mini").line(reached("Kun’s Mac mini", "Kuns-Mac-mini.local"));
    dnsSd.lookup("Kun’s MacBook Pro").line(reached("Kun’s MacBook Pro", "Kuns-MacBook-Pro.local"));
    // Both answered, and this Mac is one of them: neither is shown yet.
    expect(macs.view().macs).toEqual([]);
    tell(["kuns-macbook-pro.local"]);
    await settle();
    await settle();
    expect(macs.view().macs).toEqual([{ name: "Kun’s Mac mini", at: "Kuns-Mac-mini.local" }]);
  });

  it("takes a Mac off once it is gone from every interface", async () => {
    const { macs, dnsSd } = nearby();
    macs.ask(true);
    const browse = dnsSd.browse();
    browse.line("19:24:47.007  Add        3  14 local.               _ssh._tcp.           Studio");
    browse.line("19:24:47.007  Add        2   4 local.               _ssh._tcp.           Studio");
    dnsSd.lookup("Studio").line(reached("Studio", "Studio.local"));
    await settle();
    expect(macs.view().macs).toEqual([{ name: "Studio", at: "Studio.local" }]);
    browse.line("19:24:50.000  Rmv        0   4 local.               _ssh._tcp.           Studio");
    expect(macs.view().macs).toHaveLength(1);
    browse.line("19:24:51.000  Rmv        0  14 local.               _ssh._tcp.           Studio");
    expect(macs.view().macs).toEqual([]);
  });

  it("says macOS has not allowed the local network, and lists a Mac that answers once it is", async () => {
    const { macs, dnsSd, told } = nearby();
    macs.ask(true);
    const browse = dnsSd.browse();
    browse.line(`19:24:47.007  Error code ${POLICY_DENIED}`);
    expect(macs.view().state).toBe("not-allowed");
    expect(told.at(-1)?.state).toBe("not-allowed");
    browse.line("19:25:47.007  Add        2  14 local.               _ssh._tcp.           Studio");
    dnsSd.lookup("Studio").line(reached("Studio", "Studio.local"));
    await settle();
    expect(macs.view()).toMatchObject({
      state: "looking",
      macs: [{ name: "Studio", at: "Studio.local" }],
    });
  });

  it("says it could not look when dns-sd ends on its own or answers another error", () => {
    const ended = nearby();
    ended.macs.ask(true);
    ended.dnsSd.browse().ended(false);
    expect(ended.macs.view().state).toBe("failed");
    const refused = nearby();
    refused.macs.ask(true);
    refused.dnsSd.browse().line("DNSService call failed -65563");
    expect(refused.macs.view().state).toBe("failed");
  });

  it("asks four Macs their names at once, and the next once one answers or its run ends", async () => {
    const { macs, dnsSd } = nearby();
    macs.ask(true);
    const browse = dnsSd.browse();
    for (const name of ["A", "B", "C", "D", "E", "F"])
      browse.line(
        `19:24:47.007  Add        2  14 local.               _ssh._tcp.           ${name}`,
      );
    const asked = () =>
      dnsSd.runs.filter((run) => run.args.includes("-L")).map((run) => run.args.at(-3));
    expect(asked()).toEqual(["A", "B", "C", "D"]);
    dnsSd.lookup("A").line(reached("A", "a.local"));
    expect(asked()).toEqual(["A", "B", "C", "D", "E"]);
    // One that never answered when its five seconds ran out is left off.
    dnsSd.lookup("B").ended(true);
    expect(asked()).toEqual(["A", "B", "C", "D", "E", "F"]);
    await settle();
    expect(macs.view().macs).toEqual([{ name: "A", at: "a.local" }]);
  });

  it("browses again when a browse ran its time, dropping only a Mac it no longer announces", async () => {
    const { macs, dnsSd, time, told } = nearby();
    macs.ask(true);
    const first = dnsSd.browse();
    for (const name of ["Studio", "Mac mini"]) {
      first.line(
        `19:24:47.007  Add        2  14 local.               _ssh._tcp.           ${name}`,
      );
      dnsSd.lookup(name).line(reached(name, `${name.replace(" ", "-")}.local`));
    }
    await settle();
    expect(macs.view().macs.map((mac) => mac.name)).toEqual(["Studio", "Mac mini"]);
    const toldBefore = told.length;
    first.ended(true);
    const second = dnsSd.browse();
    expect(second).not.toBe(first);
    second.line("19:26:02.007  Add        2  14 local.               _ssh._tcp.           Studio");
    // Nothing went missing in between, and Studio's name was not asked again.
    expect(told.slice(toldBefore).every((view) => view.macs.length === 2)).toBe(true);
    expect(dnsSd.runs.filter((run) => run.args.at(-3) === "Studio")).toHaveLength(1);
    time.pass(2_000);
    expect(macs.view().macs).toEqual([{ name: "Studio", at: "Studio.local" }]);
  });

  it("stops when asked to, or a minute after the last ask, leaving nothing running", () => {
    const { macs, dnsSd, time } = nearby();
    macs.ask(true);
    dnsSd.browse().line(BROWSED[4] ?? "");
    expect(macs.ask(false)).toEqual({ state: "off", user: null, macs: [] });
    expect(dnsSd.runs.every((run) => run.stopped)).toBe(true);

    macs.ask(true);
    time.pass(NEARBY_LEASE_MS / 2);
    // Asked again inside the minute: it keeps looking a minute from then.
    macs.ask(true);
    time.pass(NEARBY_LEASE_MS / 2 + 1);
    expect(macs.view().state).toBe("looking");
    time.pass(NEARBY_LEASE_MS / 2);
    expect(macs.view().state).toBe("off");
    expect(dnsSd.runs.every((run) => run.stopped)).toBe(true);
    // An answer from a look that stopped changes nothing.
    dnsSd.runs[0]?.line(BROWSED[4] ?? "");
    expect(macs.view().state).toBe("off");
  });

  it("looks nowhere on a Mac with no dns-sd, and fills in no user an address cannot carry", () => {
    expect(nearby({ run: null }).macs.ask(true).state).toBe("off");
    expect(nearby({ user: "two words" }).macs.ask(true).user).toBeNull();
  });
});
