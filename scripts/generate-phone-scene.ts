import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/** INF-1066: native drawing shares desktop geometry and tuning, not a web runtime.
 * The comparison traces are readings of the desktop's executable choreography. */
const runner = await openModuleRunner();
try {
  const character = join(REPO_ROOT, "src/renderer/src/character");
  const { FM_STATES } = await runner.import<typeof import("../src/renderer/src/character/targets.ts")>(join(character, "targets.ts"));
  const { EMOTE_DURATION_MS, FIDGET_DURATION_MS } = await runner.import<typeof import("../src/renderer/src/character/machine.ts")>(join(character, "machine.ts"));
  const { TIER_SOLIDS } = await runner.import<typeof import("../src/renderer/src/character/crew/crewmate.ts")>(join(character, "crew/crewmate.ts"));
  const { CROWDED_PLANES, GROWING_RING, outerPlaneRadius } = await runner.import<typeof import("../src/renderer/src/character/crew/orbitalPlanes.ts")>(join(character, "crew/orbitalPlanes.ts"));
  const { CLUSTER_LAYOUT } = await runner.import<typeof import("../src/renderer/src/character/crew/computers.ts")>(join(character, "crew/computers.ts"));
  const { ORION, BIG_DIPPER } = await runner.import<typeof import("../src/renderer/src/character/constellations.ts")>(join(character, "constellations.ts"));
  const { SATURN } = await runner.import<typeof import("../src/renderer/src/character/saturn.ts")>(join(character, "saturn.ts"));
  const { GALAXY } = await runner.import<typeof import("../src/renderer/src/character/galaxy.ts")>(join(character, "galaxy.ts"));
  const { ALGOL } = await runner.import<typeof import("../src/renderer/src/character/algol.ts")>(join(character, "algol.ts"));
  const { FLICKER_TUNING } = await runner.import<typeof import("../src/renderer/src/character/flicker.ts")>(join(character, "flicker.ts"));
  const { REPLY_EMOTES, replyFrame } = await runner.import<typeof import("../src/renderer/src/character/replies.ts")>(join(character, "replies.ts"));
  const { CrewOrbit, DEFAULT_ORBIT, REMOTE_TRIP } = await runner.import<typeof import("../src/renderer/src/character/crew/orbit.ts")>(join(character, "crew/orbit.ts"));
  const { CONSTELLATION } = await runner.import<typeof import("../src/renderer/src/character/crew/constellation.ts")>(join(character, "crew/constellation.ts"));
  const { FIRSTMATE_SESSION_ID } = await runner.import<typeof import("../src/shared/observe.ts")>(join(REPO_ROOT, "src/shared/observe.ts"));
  const { DEPENDENCY_VISUAL } = await runner.import<typeof import("../src/shared/dependencyVisual.ts")>(join(REPO_ROOT, "src/shared/dependencyVisual.ts"));
  const outputs = {
    "ios/Infinitary/InfinitaryApp/PhoneSceneData.generated.json": {
      orbit: DEFAULT_ORBIT, remoteTrip: REMOTE_TRIP, program: { branchPx: CONSTELLATION.branchPx, branchDecay: CONSTELLATION.branchDecay, spreadDeg: CONSTELLATION.spreadDeg, rootMarkPx: CONSTELLATION.rootMarkPx, crewGapPx: CONSTELLATION.crewGapPx, widestSpreadDeg: CONSTELLATION.widestSpreadDeg },
      firstmateID: FIRSTMATE_SESSION_ID, dependency: DEPENDENCY_VISUAL,
      targets: FM_STATES, durations: EMOTE_DURATION_MS, fidgets: FIDGET_DURATION_MS,
      solids: TIER_SOLIDS, planes: CROWDED_PLANES,
      ring: { startRadiusPx: GROWING_RING.startRadiusPx, remoteShare: CLUSTER_LAYOUT.sizeShare }, constellations: { orion: ORION, dipper: BIG_DIPPER },
      saturn: SATURN, galaxy: GALAXY, algol: ALGOL, flicker: FLICKER_TUNING,
    },
    "ios/Infinitary/InfinitaryTests/PhoneSceneTraces.generated.json": REPLY_EMOTES.flatMap((emote) =>
      [0, 0.05, 0.15, 0.25, 0.4, 0.55, 0.7, 0.85, 1].map((progress) => ({ emote, progress, frame: replyFrame(emote, progress) }))),
    "ios/Infinitary/InfinitaryTests/PhoneOrbitSeats.generated.json": orbitSeats(),
  };
  /** INF-1325: the desktop's own seat choices through arrivals and departures, for the phone to replay. */
  function orbitSeats() {
    type Step = { arrive?: string[]; leave?: string[]; program?: { id: string; parts: string[] }; read?: boolean };
    const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
    // Every step is replayed; these arrivals, and every other step, are read back.
    const read = new Set([1, 2, 3, 9, 23, 24, 25, 26, 47, 48, 49, 50, 59, 60]);
    const grow = range("crew-", 1, 60).map((id, i) => ({ arrive: [id], read: read.has(i + 1) }));
    const sequences: Record<string, Step[]> = {
      // Growth to two full orbits and past them, a first-orbit departure above its seats, refills
      // from the second orbit below them, the second orbit closing, and a new start from empty.
      ring: [...grow, { leave: ["crew-3"] }, ...range("crew-", 4, 12).map((id) => ({ leave: [id] })),
        { leave: range("crew-", 25, 50) }, { leave: ["crew-51"] }, { leave: ["crew-60"] },
        { leave: [...range("crew-", 1, 2), ...range("crew-", 13, 24), ...range("crew-", 52, 59)] },
        ...range("crew-", 61, 63).map((id) => ({ arrive: [id] }))],
      // A program's ring takes a seat on the first orbit among the crew, and each part keeps one.
      program: [...range("crew-", 1, 5).map((id) => ({ arrive: [id] })),
        { arrive: ["part-1"], program: { id: "program", parts: ["part-1"] } }, { arrive: ["crew-6"], program: { id: "program", parts: ["part-1"] } },
        { arrive: ["part-2"], program: { id: "program", parts: ["part-1", "part-2"] } }, { leave: ["crew-2"], program: { id: "program", parts: ["part-1", "part-2"] } },
        { leave: ["part-1", "part-2"] }],
    };
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    return Object.fromEntries(Object.entries(sequences).map(([name, steps]) => {
      const orbit = new CrewOrbit(0, undefined, () => 0.5, "adaptive");
      let now = 0, present = new Set<string>(), program: Step["program"];
      return [name, steps.map((step) => {
        now += 1000;
        for (const id of step.leave ?? []) { orbit.leave(id, "home", now); present.delete(id); }
        for (const id of step.arrive ?? []) { orbit.spawn(id, "working", now); present.add(id); }
        const parts = (step.program ?? program)?.parts ?? [];
        if (step.program || program) orbit.setPrograms([{ id: (step.program ?? program)!.id, state: step.program ? "live" : "done",
          parts: parts.map((id) => ({ id, parents: [], state: present.has(id) ? "live" : "done" as const })) }], now);
        program = step.program;
        const frame = orbit.update(now, true);
        const { read, ...change } = step;
        if (read === false) return change;
        const crew = Object.fromEntries(frame.crew.filter((c) => !parts.includes(c.id)).map((c) => [c.id, [c.plane, round(c.x), round(c.y)]]));
        const marks = Object.fromEntries(frame.programs.filter((p) => p.alpha > 0).map((p) => [p.id, [round(p.x), round(p.y)]]));
        return { ...change, crew, marks, outer: round(outerPlaneRadius(present.size)) };
      })];
    }));
  }
  for (const [file, data] of Object.entries(outputs)) {
    const path = join(REPO_ROOT, file);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    if (process.argv.includes("--check")) {
      if (readFileSync(path, "utf8") !== text) throw new Error("Run node scripts/generate-phone-scene.ts");
    } else writeFileSync(path, text);
  }
} finally { await runner.close(); }
