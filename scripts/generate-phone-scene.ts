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
  const { CROWDED_PLANES } = await runner.import<typeof import("../src/renderer/src/character/crew/orbitalPlanes.ts")>(join(character, "crew/orbitalPlanes.ts"));
  const { ORION, BIG_DIPPER } = await runner.import<typeof import("../src/renderer/src/character/constellations.ts")>(join(character, "constellations.ts"));
  const { SATURN } = await runner.import<typeof import("../src/renderer/src/character/saturn.ts")>(join(character, "saturn.ts"));
  const { GALAXY } = await runner.import<typeof import("../src/renderer/src/character/galaxy.ts")>(join(character, "galaxy.ts"));
  const { ALGOL } = await runner.import<typeof import("../src/renderer/src/character/algol.ts")>(join(character, "algol.ts"));
  const { FLICKER_TUNING } = await runner.import<typeof import("../src/renderer/src/character/flicker.ts")>(join(character, "flicker.ts"));
  const { REPLY_EMOTES, replyFrame } = await runner.import<typeof import("../src/renderer/src/character/replies.ts")>(join(character, "replies.ts"));
  const { DEFAULT_ORBIT, REMOTE_TRIP } = await runner.import<typeof import("../src/renderer/src/character/crew/orbit.ts")>(join(character, "crew/orbit.ts"));
  const { CONSTELLATION } = await runner.import<typeof import("../src/renderer/src/character/crew/constellation.ts")>(join(character, "crew/constellation.ts"));
  const { FIRSTMATE_SESSION_ID } = await runner.import<typeof import("../src/shared/observe.ts")>(join(REPO_ROOT, "src/shared/observe.ts"));
  const { DEPENDENCY_VISUAL } = await runner.import<typeof import("../src/shared/dependencyVisual.ts")>(join(REPO_ROOT, "src/shared/dependencyVisual.ts"));
  const outputs = {
    "ios/Infinitary/InfinitaryApp/PhoneSceneData.generated.json": {
      orbit: DEFAULT_ORBIT, remoteTrip: REMOTE_TRIP, program: { branchPx: CONSTELLATION.branchPx, branchDecay: CONSTELLATION.branchDecay, spreadDeg: CONSTELLATION.spreadDeg, rootMarkPx: CONSTELLATION.rootMarkPx, crewGapPx: CONSTELLATION.crewGapPx, widestSpreadDeg: CONSTELLATION.widestSpreadDeg },
      firstmateID: FIRSTMATE_SESSION_ID, dependency: DEPENDENCY_VISUAL,
      targets: FM_STATES, durations: EMOTE_DURATION_MS, fidgets: FIDGET_DURATION_MS,
      solids: TIER_SOLIDS, planes: CROWDED_PLANES, constellations: { orion: ORION, dipper: BIG_DIPPER },
      saturn: SATURN, galaxy: GALAXY, algol: ALGOL, flicker: FLICKER_TUNING,
    },
    "ios/Infinitary/InfinitaryTests/PhoneSceneTraces.generated.json": REPLY_EMOTES.flatMap((emote) =>
      [0, 0.05, 0.15, 0.25, 0.4, 0.55, 0.7, 0.85, 1].map((progress) => ({ emote, progress, frame: replyFrame(emote, progress) }))),
  };
  for (const [file, data] of Object.entries(outputs)) {
    const path = join(REPO_ROOT, file);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    if (process.argv.includes("--check")) {
      if (readFileSync(path, "utf8") !== text) throw new Error("Run node scripts/generate-phone-scene.ts");
    } else writeFileSync(path, text);
  }
} finally { await runner.close(); }
