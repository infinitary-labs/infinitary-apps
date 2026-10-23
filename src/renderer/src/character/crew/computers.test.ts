import {
  type CenterNode,
  centerCues,
  crewedWaits,
  DEPENDENCY_VISUAL,
} from "@shared/dependencyVisual";
import type { DeviceView } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { CLUSTER_LAYOUT, ComputerOrbits, HOME_COMPUTER, outerPlaneRadius } from "./computers";
import { crewHit } from "./hover";
import { markOf, programMarks, stageMarks } from "./marks";
import { CrewOrbit, DEFAULT_ORBIT, remoteTripMs } from "./orbit";

const device = (id: string, patch: Partial<DeviceView> = {}): DeviceView => ({
  id,
  kind: "work",
  name: `Computer ${id}`,
  pairedAt: 1,
  inReach: true,
  ...patch,
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing model output");
  return value;
}
function seed(model: ComputerOrbits, id: string, computer: string | null) {
  model.setPlacement(id, computer);
  model.spawn(id, "working", 0, true, "high");
}
describe("computer constellations", () => {
  it("notifies the existing painter when only remote membership or state changes", () => {
    const model = new ComputerOrbits(0);
    model.configure([device("peer")]);
    model.setPlacement("remote", "peer");
    let notifications = 0;
    const off = model.subscribe(() => notifications++);
    model.spawn("remote", "working", 0, true);
    expect(notifications).toBeGreaterThan(0);
    const afterSpawn = notifications;
    model.setStatus("remote", "idle");
    expect(notifications).toBeGreaterThan(afterSpawn);
    const afterStatus = notifications;
    model.signal("remote", "report", 0);
    expect(notifications).toBeGreaterThan(afterStatus);
    off();
  });

  it.each([0, 4, 9, 24, 48])(
    "keeps %i home crew's complete original frames when remote computers are added",
    (count) => {
      const random = () => {
        let n = 0;
        return () => ((++n * 37) % 100) / 100;
      };
      const original = new CrewOrbit(0, undefined, random(), "adaptive");
      const model = new ComputerOrbits(0, random());
      for (let i = 0; i < count; i++) {
        const id = `home${i}`;
        original.spawn(id, "working", 0, true, "high");
        seed(model, id, null);
      }
      original.settleBootRoster(0);
      model.settleBootRoster(0);
      expect(model.update(0)).toEqual(original.update(0));
      model.configure([device("peer"), device("empty")]);
      for (let i = 0; i < 64; i++) seed(model, `remote${i}`, "peer");
      model.settleBootRoster(0);
      for (let now = 16; now < 1200; now += 16) {
        if (now === 320 && count) {
          original.setStatus("home0", "idle");
          model.setStatus("home0", "idle");
        }
        const expected = original.update(now);
        const frame = model.update(now);
        const home = frame.crew
          .filter((c) => c.computerId === HOME_COMPUTER)
          .map(({ computerId: _computerId, ...crew }) => crew);
        expect(home).toEqual(expected.crew);
        expect(frame.planeBlend).toBe(expected.planeBlend);
        expect(frame.formation).toBe(expected.formation);
        expect(frame.ringRadius).toBe(expected.ringRadius);
      }
    },
  );

  it("returns the original single-computer frames and cues, without added fields", () => {
    const original = new CrewOrbit(0, undefined, () => 0.5, "adaptive");
    const model = new ComputerOrbits(0, () => 0.5);
    model.configure([device("local", { onThisMac: true }), device("view", { kind: "view" })]);
    for (let i = 0; i < 24; i++) {
      original.spawn(String(i), "working", 0, true);
      original.setStatus(String(i), "idle");
      seed(model, String(i), i % 2 ? "local" : null);
      model.setStatus(String(i), "idle");
      original.setTier(String(i), "high");
    }
    original.settleBootRoster(0);
    model.settleBootRoster(0);
    for (let now = 0; now < 1200; now += 16) {
      expect(model.update(now)).toEqual(original.update(now));
      expect(model.takeCues()).toEqual(original.takeCues());
    }
    expect(model.clusters()).toEqual([]);
  });
  it("does not invent placement for an older home that has not published it", () => {
    const model = new ComputerOrbits(0);
    model.configure([device("a")]);
    model.spawn("unknown", "idle", 0, true);
    expect(model.multiple).toBe(false);
    expect(model.update(0, true).clustered).toBeUndefined();
    model.setPlacement("unknown", null);
    expect(model.multiple).toBe(true);
  });

  it("fills local planes independently and uses stable computer identities, including same-Mac users", () => {
    const model = new ComputerOrbits(0);
    model.configure([
      device("a"),
      device("b"),
      device("user", { onThisMac: true }),
      device("view", { kind: "view" }),
    ]);
    for (let i = 0; i < 9; i++) seed(model, `a${i}`, "a");
    seed(model, "b", "b");
    seed(model, "home", "user");
    model.settleBootRoster(0);
    const frame = model.update(0, true);
    expect(
      frame.crew
        .filter((c) => c.computerId === "a")
        .map((c) => c.plane)
        .sort(),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(frame.crew.find((c) => c.id === "b")?.plane).toBe(0);
    expect(frame.crew.find((c) => c.id === "home")?.computerId).toBe(HOME_COMPUTER);
    const before = frame.crew.map((c) => [c.id, c.x, c.y]);
    model.configure([
      device("b", { name: "Same name" }),
      device("a", { name: "Same name" }),
      device("user", { onThisMac: true }),
    ]);
    expect(model.update(0, true).crew.map((c) => [c.id, c.x, c.y])).toEqual(before);
  });
  it("retains configured empty and unreachable clusters and never paints guessed activity", () => {
    const model = new ComputerOrbits(0);
    model.configure([device("a")]);
    seed(model, "a", "a");
    model.settleBootRoster(0);
    const before = required(model.update(100).crew.find((c) => c.id === "a"));
    model.configure([device("a", { inReach: false }), device("empty", { inReach: false })]);
    const frozen = required(model.update(100).crew.find((c) => c.id === "a"));
    const later = required(model.update(20000).crew.find((c) => c.id === "a"));
    expect(later).toEqual(frozen);
    expect(later.work).toBe(0);
    expect(later.status).toBe("idle");
    // A configured computer with no crew keeps no seat; it takes one with its first crewmate.
    expect(model.clusters().map((c) => c.id)).toEqual(["home", "a"]);
    expect(model.pages).toBe(1);
    seed(model, "e", "empty");
    model.update(20016);
    expect(model.clusters().map((c) => c.id)).toEqual(["home", "a", "empty"]);
    expect(before.id).toBe(later.id);
  });
  it("pages all computers without dropping tasks or duplicating the home Firstmate", () => {
    const model = new ComputerOrbits(0);
    model.configure(Array.from({ length: 12 }, (_, i) => device(String(i), { pairedAt: i })));
    for (let i = 0; i < 12; i++) seed(model, `crew${i}`, String(i));
    model.settleBootRoster(0);
    expect(model.pages).toBe(3);
    const seen = new Set<string>();
    for (let page = 0; page < model.pages; page++) {
      model.setPage(page);
      const clusters = model.clusters();
      expect(clusters[0]?.id).toBe(HOME_COMPUTER);
      expect(clusters.length).toBeLessThanOrEqual(6);
      for (const c of model.update(0, true).crew) seen.add(c.id);
    }
    expect(seen.size).toBe(12);
    expect(model.present().length).toBe(12);
  });
  it("directs remote reports and steers between the remote orbit and the single Firstmate", () => {
    const model = new ComputerOrbits(0);
    model.configure([device("a")]);
    seed(model, "a", "a");
    model.settleBootRoster(0);
    model.update(0);
    model.signal("a", "report", 0);
    model.signal("a", "steer", 0);
    const frame = model.update(16);
    const crew = required(frame.crew[0]);
    const report = required(frame.packets.find((p) => p.direction === "report"));
    const steer = required(frame.packets.find((p) => p.direction === "steer"));
    expect(Math.hypot(report.x - crew.x, report.y - crew.y)).toBeLessThan(10);
    expect(Math.hypot(steer.x, steer.y)).toBeLessThan(10);
    expect(model.takeCues().some((c) => c.kind === "sendoff" && c.dx > 0)).toBe(true);
    // A leave waits for a spark still on its way out (INF-759): let it land first.
    let landed = 32;
    while (model.update(landed).packets.length > 0) landed += 16;
    model.leave("a", "home", landed);
    // The fall home takes longer the farther the cluster sits (REMOTE_TRIP).
    for (let now = landed + 16; now < landed + 1600; now += 16) model.update(now);
    expect(model.has("a")).toBe(false);
    expect(model.takeCues()).toContainEqual({ kind: "receive" });
  });
  it("updates known membership while unreachable without retaining a closed or moved identity", () => {
    const model = new ComputerOrbits(0);
    model.configure([device("a", { inReach: false }), device("b", { inReach: false })]);
    model.update(0, true);
    seed(model, "crew", "a");
    model.settleBootRoster(0);
    expect(model.update(0, true).crew.map((c) => c.id)).toEqual(["crew"]);
    model.setPlacement("crew", "b");
    expect(model.update(0, true).crew.map((c) => [c.id, c.computerId])).toEqual([["crew", "b"]]);
    model.leave("crew", "home", 1);
    expect(model.update(2, true).crew).toEqual([]);
  });

  it("carries review edges and corrected placements without duplicate crew", () => {
    const model = new ComputerOrbits(0);
    model.setReview("review", "builder");
    seed(model, "builder", "a");
    seed(model, "review", "a");
    model.configure([device("a"), device("b")]);
    model.settleBootRoster(0);
    const slots = (m: ComputerOrbits) => m.update(0, true).crew.map((c) => [c.id, c.x, c.y]);
    const plain = new ComputerOrbits(0);
    seed(plain, "builder", "a");
    seed(plain, "review", "a");
    plain.configure([device("a"), device("b")]);
    plain.settleBootRoster(0);
    // The reviewer on the same remote computer circles its builder; the builder stays.
    const circled = new Map(slots(model).map(([id, x]) => [id, x]));
    const resting = new Map(slots(plain).map(([id, x]) => [id, x]));
    expect(circled.get("builder")).toBe(resting.get("builder"));
    expect(circled.get("review")).not.toBe(resting.get("review"));
    model.setPlacement("builder", "b");
    const frame = model.update(0, true);
    expect(frame.crew).toHaveLength(2);
    expect(frame.crew.find((c) => c.id === "builder")?.computerId).toBe("b");
    expect(frame.crew.find((c) => c.id === "builder")?.tier).toBe("high");
  });

  describe("reviews on the stage (INF-51)", () => {
    const stage = (placements: Record<string, string | null>, reviews: [string, string][]) => {
      const model = new ComputerOrbits(0);
      model.configure([device("a"), device("b")]);
      for (const [id, computer] of Object.entries(placements)) seed(model, id, computer);
      for (const [reviewer, builder] of reviews) model.setReview(reviewer, builder);
      model.settleBootRoster(0);
      return model;
    };
    const xs = (model: ComputerOrbits) =>
      new Map(model.update(0, true).crew.map((c) => [c.id, c.x] as const));

    it("keeps a reviewer on another computer than its builder on its own slot", () => {
      const placements = { builder: "a", review: "b" };
      const apart = xs(stage(placements, [["review", "builder"]]));
      const plain = xs(stage(placements, []));
      expect(apart.get("review")).toBe(plain.get("review"));
      expect(apart.get("builder")).toBe(plain.get("builder"));
    });

    // Captain (INF-556): "for a reviewer relationship, it should use the orange color
    // that we use as active", and a review between computers gets "the same reach as waits".
    it("draws a review between computers as a review arrow across the stage", () => {
      const model = stage({ builder: null, review: "b" }, [["review", "builder"]]);
      expect(model.update(0, true).links).toEqual([
        { fromId: "review", toId: "builder", kind: "review" },
      ]);
      model.setReview("review", null);
      expect(model.update(0, true).links).toEqual([]);
    });

    it("flies a reviewer on another computer to the first mate when its review closes", () => {
      const model = stage({ builder: "a", review: "a" }, [["review", "builder"]]);
      let now = 0;
      const frame = () => model.update(now).crew.find((c) => c.id === "review");
      for (; now < 3000; now += 16) frame();
      const start = frame();
      model.leave("review", "home", now);
      let last = start;
      // The trip to the first mate takes longer the farther it flies; read its last frame.
      for (let t = 0; t < 3000; t += 16) {
        now += 16;
        const next = frame();
        if (!next) break;
        last = next;
      }
      const reach = (c?: { x: number; y: number }) => Math.hypot(c?.x ?? 0, c?.y ?? 0);
      // It falls toward the center, not toward the cluster seat beside it.
      expect(reach(last)).toBeLessThan(reach(start) * 0.25);
    });

    it("keeps the other reviewer circling when one of two reviews closes", () => {
      const placements = { builder: "a", r1: "a", r2: "a" };
      const both = stage(placements, [
        ["r1", "builder"],
        ["r2", "builder"],
      ]);
      const plain = xs(stage(placements, []));
      both.setReview("r1", null);
      const after = xs(both);
      expect(after.get("r2")).not.toBe(plain.get("r2"));
      expect(after.get("r1")).toBe(plain.get("r1"));
    });

    it("shares seats with a waiting crewmate, each with its arrow to the builder", () => {
      const model = stage({ builder: "a", waiter: "a", review: "a" }, [["review", "builder"]]);
      model.setDependencies([
        {
          waiterId: "waiter",
          mode: "satellite",
          blockerId: "builder",
          index: 0,
          count: 1,
          arrows: ["builder"],
        },
      ]);
      const plain = xs(stage({ builder: "a", waiter: "a", review: "a" }, []));
      const frame = model.update(0, true);
      expect(frame.links.map((l) => `${l.fromId}>${l.toId}`).sort()).toEqual([
        "review>builder",
        "waiter>builder",
      ]);
      for (const id of ["waiter", "review"])
        expect(frame.crew.find((c) => c.id === id)?.x).not.toBe(plain.get(id));
    });

    // Captain (INF-304): crewmates moved apart when they came too close, "this is too
    // distracting, so i think we should just not care about collision", and the arrows
    // "should be present at all times".
    it("keeps circling past unrelated crewmates, its arrow drawn in every frame", () => {
      const ids = ["builder", "waiter", "other0", "other1", "author", "review"];
      for (let i = 2; i < 12; i++) ids.push(`other${i}`);
      const model = new ComputerOrbits(0);
      model.configure([device("a"), device("b")]);
      for (const id of ids) seed(model, id, null);
      model.setReview("review", "author");
      model.setDependencies(
        centerCues(
          ids.map((id) => ({
            id,
            key: id,
            blockedBy: id === "waiter" ? ["builder"] : [],
            deviceId: null,
            idleDependency: id === "waiter",
            crewed: true,
          })),
        ),
      );
      model.settleBootRoster(0);
      const pairs = [
        ["waiter", "builder", "wait"],
        ["review", "author", "review"],
      ] as const;
      let closest = Number.POSITIVE_INFINITY;
      // A minute of stage time, frame by frame.
      for (let now = 0; now <= 60_000; now += 16) {
        const frame = model.update(now);
        const at = (id: string) => required(frame.crew.find((c) => c.id === id));
        for (const [from, to, kind] of pairs) {
          expect(frame.links).toContainEqual({ fromId: from, toId: to, kind });
          const mine = at(from);
          // On its circle about the one it waits on or reviews, never back on its slot.
          expect(Math.hypot(mine.x - at(to).x, mine.y - at(to).y)).toBeLessThan(
            DEPENDENCY_VISUAL.radiusPx * 1.25,
          );
          for (const other of frame.crew) {
            if (other.id.startsWith("other"))
              closest = Math.min(
                closest,
                Math.hypot(other.x - mine.x, other.y - mine.y) / mine.size,
              );
          }
        }
      }
      // The minute did bring an unrelated crewmate within a glyph of a circling one.
      expect(closest).toBeLessThan(1);
    });
  });

  // Captain (INF-556): "i do think drawing a wait between computers may be helpful",
  // chosen as "Solid gray, like every other wait".
  describe("waits between computers", () => {
    const node = (id: string, deviceId: string | null, blockedBy: string[] = []): CenterNode => ({
      id,
      key: id,
      blockedBy,
      deviceId,
      idleDependency: blockedBy.length > 0,
      crewed: true,
    });
    const stage = (nodes: CenterNode[], waits: boolean) => {
      const model = new ComputerOrbits(0);
      model.configure([device("mini")]);
      for (const n of nodes) seed(model, n.id, n.deviceId);
      model.setDependencies(centerCues(nodes));
      if (waits) model.setWaits(crewedWaits(nodes));
      model.settleBootRoster(0);
      return model;
    };
    // INF-528 on this computer waits on INF-541 and INF-542 on the Mac mini.
    const board = [
      node("INF-528", null, ["INF-541", "INF-542"]),
      node("INF-541", "mini"),
      node("INF-542", "mini"),
    ];

    it("draws each wait across to the other computer, and nobody moves for it", () => {
      const model = stage(board, true);
      const frame = model.update(0, true);
      expect(frame.links).toEqual([
        { fromId: "INF-528", toId: "INF-541", kind: "wait" },
        { fromId: "INF-528", toId: "INF-542", kind: "wait" },
      ]);
      const plain = stage(board, false).update(0, true);
      expect(plain.links).toEqual([]);
      expect(frame.crew.map((c) => [c.id, c.x, c.y])).toEqual(
        plain.crew.map((c) => [c.id, c.x, c.y]),
      );
      model.setWaits([]);
      expect(model.update(0, true).links).toEqual([]);
    });

    it("keeps a wait inside one computer on that computer's orbit, drawn once", () => {
      const nodes = [node("waiter", "mini", ["blocker"]), node("blocker", "mini")];
      expect(stage(nodes, true).update(0, true).links).toEqual([
        { fromId: "waiter", toId: "blocker", kind: "wait" },
      ]);
    });

    it("draws no arrow back from a builder to its reviewer on another computer", () => {
      // The host records the builder's merge hold on its review as a wait.
      const nodes = [node("builder", null, ["review"]), node("review", "mini")];
      const model = stage(nodes, true);
      model.setReview("review", "builder");
      expect(model.update(0, true).links).toEqual([
        { fromId: "review", toId: "builder", kind: "review" },
      ]);
    });
  });
});

describe("a program on another computer", () => {
  // INF-999: INF-505, INF-527 and INF-867 had their live parts on the Mac
  // mini, yet drew at home, piled with INF-923's; the captain chose to draw
  // a constellation in the group of the computer running its live parts.
  it("draws in the group of the computer running its live part, with that part seated", () => {
    const model = new ComputerOrbits(0);
    model.configure([device("mini")]);
    seed(model, "778", null);
    seed(model, "507", "mini");
    seed(model, "925", null);
    model.setPrograms(
      [
        {
          id: "505",
          state: "live",
          parts: [
            { id: "506", parents: [], state: "done" },
            { id: "507", parents: ["506"], state: "live" },
          ],
        },
        { id: "923", state: "live", parts: [{ id: "925", parents: [], state: "live" }] },
      ],
      0,
    );
    model.settleBootRoster(0);
    const frame = model.update(0, true);
    const mini = required(model.clusters().find((cluster) => cluster.id === "mini"));
    const program = (id: string) => required(frame.programs.find((p) => p.id === id));
    const from = (p: { x: number; y: number }, c: { x: number; y: number }) =>
      Math.hypot(p.x - c.x, p.y - c.y);
    expect(from(program("505"), mini)).toBeLessThan(mini.radius + 1);
    expect(from(program("923"), { x: 0, y: 0 })).toBeLessThan(from(program("923"), mini));
    // Each live part sits at its node on its own computer's orbit.
    for (const [parent, part] of [
      ["505", "507"],
      ["923", "925"],
    ] as const) {
      const node = required(program(parent).nodes.find((n) => n.id === part));
      const mate = required(frame.crew.find((c) => c.id === part));
      expect(mate.x).toBeCloseTo(node.x);
      expect(mate.y).toBeCloseTo(node.y);
    }
  });
});

// INF-1037, the captain's choice A: "a copy of the ring on each computer that
// runs parts, each with its own crewmates". INF-1017 at 11:13 AM: 20 finished
// parts, 5 verifiers running here and 3 on the Mac mini.
describe("a program running parts on two computers", () => {
  function inf1017() {
    const model = new ComputerOrbits(0);
    model.configure([device("mini")]);
    const here = ["1042", "1043", "1044", "1045", "1046"];
    const mini = ["1039", "1040", "1041"];
    for (const id of here) seed(model, id, null);
    for (const id of mini) seed(model, id, "mini");
    const finished = Array.from({ length: 20 }, (_, i) => ({
      id: String(1018 + i),
      parents: [],
      state: "done" as const,
    }));
    const running = [...mini, ...here].map((id) => ({
      id,
      parents: [],
      state: "live" as const,
    }));
    model.setPrograms([{ id: "1017", state: "live", parts: [...finished, ...running] }], 0);
    model.settleBootRoster(0);
    return { model, here, mini };
  }

  it("draws a ring in each computer's group, each with only the crewmates running there", () => {
    const { model, here, mini } = inf1017();
    const frame = model.update(0, true);
    const rings = frame.programs.filter((p) => p.id === "1017");
    expect(rings).toHaveLength(2);
    const cluster = required(model.clusters().find((c) => c.id === "mini"));
    const near = (p: { x: number; y: number }) =>
      Math.hypot(p.x - cluster.x, p.y - cluster.y) < cluster.radius + 1;
    const atMini = required(rings.find(near));
    const atHome = required(rings.find((p) => !near(p)));
    // Nothing but the running crewmates: no finished part has a node.
    expect(atHome.nodes.map((n) => n.id).sort()).toEqual([...here].sort());
    expect(atMini.nodes.map((n) => n.id).sort()).toEqual([...mini].sort());
    for (const ring of [atHome, atMini]) {
      expect(ring.branches.every((b) => b.fromId === "1017")).toBe(true);
      for (const node of ring.nodes) {
        const mate = required(frame.crew.find((c) => c.id === node.id));
        expect(mate.x).toBeCloseTo(node.x);
        expect(mate.y).toBeCloseTo(node.y);
      }
    }
    // Every crewmate stays where its work runs.
    for (const id of mini) expect(frame.crew.find((c) => c.id === id)?.computerId).toBe("mini");
  });

  it("opens the ring's summary beside the copy pointed at, and gives the keyboard one ring", () => {
    const { model } = inf1017();
    const frame = model.update(0, true);
    const cluster = required(model.clusters().find((c) => c.id === "mini"));
    const rings = stageMarks(frame).filter((mark) => mark.id === "1017");
    expect(rings).toHaveLength(2);
    for (const ring of rings) {
      expect(crewHit(stageMarks(frame), ring.x, ring.y)).toBe("1017");
      expect(markOf(stageMarks(frame), "1017", ring)).toEqual(ring);
    }
    const a = required(rings[0]);
    const b = required(rings[1]);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(cluster.radius);
    expect(programMarks(frame).filter((mark) => mark.id === "1017")).toHaveLength(1);
  });

  it("keeps a ring where it was drawn between stages, and lets a computer's copy go once its parts finish", () => {
    const { model, here, mini } = inf1017();
    model.update(0, true);
    const parts = (live: readonly string[]) =>
      [...here, ...mini].map((id) => ({
        id,
        parents: [],
        state: live.includes(id) ? ("live" as const) : ("done" as const),
      }));
    model.setPrograms([{ id: "1017", state: "live", parts: parts(here) }], 0);
    expect(model.update(0, true).programs.filter((p) => p.id === "1017")).toHaveLength(1);
    model.setPrograms([{ id: "1017", state: "live", parts: parts([]) }], 0);
    const between = model.update(0, true).programs.filter((p) => p.id === "1017");
    expect(between).toHaveLength(1);
    expect(between[0]?.nodes).toEqual([]);
  });
});

describe("the multi-computer stage (FI3-1519)", () => {
  const gap = CLUSTER_LAYOUT.gapPx;
  const remoteRadius = (count: number) => outerPlaneRadius(count) * CLUSTER_LAYOUT.sizeShare;
  function fleet(counts: Record<string, number>, home = 6) {
    const model = new ComputerOrbits(0, () => 0.5);
    model.configure(
      Object.keys(counts).map((id, i) => device(id, { pairedAt: i + 1, name: `Mac ${id}` })),
    );
    for (let i = 0; i < home; i++) seed(model, `h${i}`, null);
    for (const [id, count] of Object.entries(counts))
      for (let i = 0; i < count; i++) seed(model, `${id}${i}`, id);
    model.settleBootRoster(0);
    for (let now = 16; now <= 3000; now += 16) model.update(now);
    return model;
  }
  const homeOf = (frame: ReturnType<ComputerOrbits["update"]>) =>
    new Map(frame.crew.filter((c) => c.computerId === HOME_COMPUTER).map((c) => [c.id, c]));
  const moved = (
    a: Map<string, { x: number; y: number }>,
    b: Map<string, { x: number; y: number }>,
  ) =>
    Math.max(
      0,
      ...[...a].map(([id, p]) => {
        const q = b.get(id);
        return q ? Math.hypot(p.x - q.x, p.y - q.y) : 0;
      }),
    );

  it("seats crewed computers in two wings beyond the home formation's edge plus the gap, stacked within a wing, and gives an empty computer no seat", () => {
    const model = fleet({ a: 6, b: 9, c: 1, empty: 0 });
    const frame = model.update(3016, true);
    const by = Object.fromEntries(model.clusters().map((c) => [c.id, c]));
    const homeEdge = outerPlaneRadius(6) + CLUSTER_LAYOUT.glyphPx;
    expect(by.empty).toBeUndefined();
    // The first and third computers share the right wing, as wide as the wider needs; the second sits left.
    expect(by.a?.radius).toBe(remoteRadius(6));
    expect(by.b?.radius).toBe(remoteRadius(9));
    expect(by.a?.x).toBeCloseTo(homeEdge + gap + remoteRadius(6), 6);
    expect(by.c?.x).toBe(by.a?.x);
    expect(by.b?.x).toBeCloseTo(-(homeEdge + gap + remoteRadius(9)), 6);
    expect(by.b?.y).toBe(0);
    expect(by.a?.y ?? 0).toBeLessThan(0);
    expect(by.c?.y ?? 0).toBeGreaterThan(0);
    expect((by.c?.y ?? 0) - (by.a?.y ?? 0)).toBeCloseTo(
      2 * remoteRadius(6) + gap + CLUSTER_LAYOUT.stackPx,
      6,
    );
    expect(by.a?.labelY).toBeCloseTo((by.a?.y ?? 0) + remoteRadius(6) + CLUSTER_LAYOUT.labelPx, 6);
    // Every remote crewmate clears the home formation's edge by the gap.
    for (const c of frame.crew.filter((c) => c.computerId !== HOME_COMPUTER))
      expect(Math.hypot(c.x, c.y)).toBeGreaterThanOrEqual(homeEdge + gap - 1);
    // The scene reaches as far as its widest wing and its lowest cluster, clear air included.
    expect(frame.scene).toEqual({
      halfWidth: Math.max(
        (by.a?.x ?? 0) + remoteRadius(6) + CLUSTER_LAYOUT.sideMarginPx,
        -(by.b?.x ?? 0) + remoteRadius(9) + CLUSTER_LAYOUT.sideMarginPx,
      ),
      halfHeight: (by.c?.y ?? 0) + remoteRadius(6) + CLUSTER_LAYOUT.endMarginPx,
    });
    // The single-computer path is untouched: no scene, no clusters.
    const single = new ComputerOrbits(0, () => 0.5);
    seed(single, "only", null);
    expect(single.update(0, true).scene).toBeUndefined();
  });

  it("glides a cluster to its new seat when the home formation grows an orbit, never jumping", () => {
    const model = fleet({ a: 6 }, 8);
    const before = required(model.clusters().find((c) => c.id === "a"));
    seed(model, "h8", null);
    let prev = before.x;
    let worstStep = 0;
    let now = 3016;
    for (; now <= 6000; now += 16) {
      model.update(now);
      const x = required(model.clusters().find((c) => c.id === "a")).x;
      worstStep = Math.max(worstStep, Math.abs(x - prev));
      prev = x;
    }
    const after = required(model.clusters().find((c) => c.id === "a"));
    expect(after.x - before.x).toBeCloseTo(outerPlaneRadius(9) - outerPlaneRadius(8), 1);
    expect(worstStep).toBeLessThan(8);
    expect(worstStep).toBeGreaterThan(0.5);
  });

  it("keeps remote crew at their own pace through the black hole's rush, with no streak", () => {
    const racing = fleet({ a: 6 });
    const calm = fleet({ a: 6 });
    for (let now = 3016; now <= 4000; now += 16) {
      const rushed = racing.update(now, false, 1);
      const steady = calm.update(now, false, 0);
      expect(rushed.travel).toBe(36);
      const remote = (frame: typeof rushed) =>
        frame.crew.filter((c) => c.computerId === "a").map((c) => [c.id, c.x, c.y, c.streak]);
      expect(remote(rushed)).toEqual(remote(steady));
      expect(rushed.crew.some((c) => c.computerId === HOME_COMPUTER && c.streak)).toBe(true);
    }
  });

  it("flies a remote spark along one smooth path from the Firstmate to its slot, taking longer the farther it flies, and hands the Firstmate a unit direction", () => {
    const model = fleet({ a: 6, b: 6 });
    model.takeCues();
    model.setPlacement("new", "b");
    model.spawn("new", "working", 3000);
    const steps: number[] = [];
    let prev: { x: number; y: number } | null = null;
    let first: { x: number; y: number } | null = null;
    let arrived = 0;
    for (let now = 3016; now <= 5000 && !arrived; now += 16) {
      const c = required(model.update(now).crew.find((c) => c.id === "new"));
      first ??= { x: c.x, y: c.y };
      if (prev) steps.push(Math.hypot(c.x - prev.x, c.y - prev.y));
      if (c.phase === "orbiting") arrived = now - 3000;
      prev = { x: c.x, y: c.y };
    }
    const seat = required(model.clusters().find((c) => c.id === "b"));
    const distance = Math.hypot(prev?.x ?? 0, prev?.y ?? 0);
    expect(Math.hypot(first?.x ?? 0, first?.y ?? 0)).toBeLessThan(40);
    expect(Math.abs((prev?.x ?? 0) - seat.x)).toBeLessThanOrEqual(seat.radius + 1);
    expect(arrived).toBeGreaterThan(DEFAULT_ORBIT.spawnMs);
    expect(Math.abs(arrived - remoteTripMs(DEFAULT_ORBIT.spawnMs, distance))).toBeLessThanOrEqual(
      32,
    );
    // Eased once: every step shorter than the last, none a dash.
    for (let i = 1; i < steps.length; i++)
      expect(steps[i]).toBeLessThanOrEqual((steps[i - 1] ?? 0) + 0.01);
    expect(Math.max(...steps)).toBeLessThan(20);
    const cue = model.takeCues().find((c) => c.kind === "sendoff");
    if (cue?.kind !== "sendoff") throw new Error("No send-off cue");
    expect(Math.hypot(cue.dx, cue.dy)).toBeCloseTo(1, 6);
    expect(Math.sign(cue.dx)).toBe(Math.sign(seat.x));
  });

  it("falls home and sends packets by the same distance rule", () => {
    const model = fleet({ a: 6 });
    const crew = required(model.update(3000).crew.find((c) => c.id === "a0"));
    const distance = Math.hypot(crew.x, crew.y);
    model.signal("a0", "report", 3000);
    let packetGone = 0;
    let gone = 0;
    // One continuous clock: the report at 3 s, the finish at 5 s.
    for (let now = 3016; now <= 7000; now += 16) {
      if (now === 5000) model.leave("a0", "home", now);
      const frame = model.update(now);
      if (!packetGone && now < 5000 && frame.packets.length === 0) packetGone = now - 3000;
      if (!gone && now > 5000 && !frame.crew.some((c) => c.id === "a0")) gone = now - 5000;
    }
    expect(
      Math.abs(packetGone - remoteTripMs(DEFAULT_ORBIT.packetMs, distance)),
    ).toBeLessThanOrEqual(32);
    expect(packetGone).toBeGreaterThan(DEFAULT_ORBIT.packetMs);
    expect(Math.abs(gone - remoteTripMs(DEFAULT_ORBIT.homeMs, distance))).toBeLessThanOrEqual(32);
    expect(gone).toBeGreaterThan(DEFAULT_ORBIT.homeMs);
    expect(model.takeCues()).toContainEqual({ kind: "receive" });
  });

  it("takes a placement that arrives after the spawn without disturbing the home ring, and keeps the spark", () => {
    const model = fleet({ a: 6 });
    const before = homeOf(model.update(3000));
    model.spawn("late", "working", 3000);
    model.update(3016);
    model.setPlacement("late", "a");
    const after = model.update(3032);
    expect(moved(before, homeOf(after))).toBeLessThan(4);
    const late = required(after.crew.find((c) => c.id === "late"));
    expect(late.computerId).toBe("a");
    expect(late.phase).toBe("spawning");
    let prev = homeOf(after);
    for (let now = 3048; now <= 4500; now += 16) {
      const frame = homeOf(model.update(now));
      expect(moved(prev, frame)).toBeLessThan(4);
      prev = frame;
    }
    expect(model.has("late")).toBe(true);
    expect(model.present().filter((id) => id === "late")).toHaveLength(1);
  });
});
