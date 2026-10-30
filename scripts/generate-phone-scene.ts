import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeCheckState } from "../src/shared/checkSnapshot.ts";
import type { TaskFactsInput } from "../src/shared/taskFacts.ts";
import type { TaskPlanItem } from "../src/shared/taskPlan.ts";
import type { TaskDetail, TaskView } from "../src/shared/tasks.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/** INF-1066: native drawing shares desktop geometry and tuning, not a web runtime.
 * The comparison traces are readings of the desktop's executable choreography. */
const runner = await openModuleRunner();
try {
  const character = join(REPO_ROOT, "src/renderer/src/character");
  const { FM_STATES } = await runner.import<typeof import("../src/renderer/src/character/targets.ts")>(join(character, "targets.ts"));
  const { EMOTE_DURATION_MS, FIDGET_DURATION_MS } = await runner.import<typeof import("../src/renderer/src/character/machine.ts")>(join(character, "machine.ts"));
  const { CAPTAIN_LIGHT, TIER_SOLIDS, WAIT_LIGHT } = await runner.import<typeof import("../src/renderer/src/character/crew/crewmate.ts")>(join(character, "crew/crewmate.ts"));
  const { CROWDED_PLANES, GROWING_RING, outerPlaneRadius } = await runner.import<typeof import("../src/renderer/src/character/crew/orbitalPlanes.ts")>(join(character, "crew/orbitalPlanes.ts"));
  const { CLUSTER_LAYOUT } = await runner.import<typeof import("../src/renderer/src/character/crew/computers.ts")>(join(character, "crew/computers.ts"));
  const { ORION, BIG_DIPPER } = await runner.import<typeof import("../src/renderer/src/character/constellations.ts")>(join(character, "constellations.ts"));
  const { SATURN } = await runner.import<typeof import("../src/renderer/src/character/saturn.ts")>(join(character, "saturn.ts"));
  const { GALAXY } = await runner.import<typeof import("../src/renderer/src/character/galaxy.ts")>(join(character, "galaxy.ts"));
  const { ALGOL } = await runner.import<typeof import("../src/renderer/src/character/algol.ts")>(join(character, "algol.ts"));
  const { TRAVEL_PER_SECOND, WARP, WARP_LEAD, WARP_SCHEDULE, WARP_STARS, WARP_TRAVEL } = await runner.import<typeof import("../src/renderer/src/character/warp.ts")>(join(character, "warp.ts"));
  const { WARP_RELEASE_MS } = await runner.import<typeof import("../src/renderer/src/character/crew/warp.ts")>(join(character, "crew/warp.ts"));
  const { FLICKER_TUNING } = await runner.import<typeof import("../src/renderer/src/character/flicker.ts")>(join(character, "flicker.ts"));
  const { REPLY_EMOTES, replyFrame } = await runner.import<typeof import("../src/renderer/src/character/replies.ts")>(join(character, "replies.ts"));
  const { CAPTAIN_BREATH_MS, CrewOrbit, DEFAULT_ORBIT, PLANES_GLYPH_PX, REMOTE_TRIP, WAIT_ARC_RATE } = await runner.import<typeof import("../src/renderer/src/character/crew/orbit.ts")>(join(character, "crew/orbit.ts"));
  const { CONSTELLATION } = await runner.import<typeof import("../src/renderer/src/character/crew/constellation.ts")>(join(character, "crew/constellation.ts"));
  const { FIRSTMATE_SESSION_ID } = await runner.import<typeof import("../src/shared/observe.ts")>(join(REPO_ROOT, "src/shared/observe.ts"));
  const { DEPENDENCY_VISUAL } = await runner.import<typeof import("../src/shared/dependencyVisual.ts")>(join(REPO_ROOT, "src/shared/dependencyVisual.ts"));
  const { taskFactsOf } = await runner.import<typeof import("../src/shared/taskFacts.ts")>(join(REPO_ROOT, "src/shared/taskFacts.ts"));
  const { taskStatusLabel } = await runner.import<typeof import("../src/shared/taskPresentation.ts")>(join(REPO_ROOT, "src/shared/taskPresentation.ts"));
  const { checksFinishedAgo, checksSpanWords } = await runner.import<typeof import("../src/shared/checksSpan.ts")>(join(REPO_ROOT, "src/shared/checksSpan.ts"));
  const { reasoningWord } = await runner.import<typeof import("../src/shared/reasoning.ts")>(join(REPO_ROOT, "src/shared/reasoning.ts"));
  const { feedRelativeAge } = await runner.import<typeof import("../src/shared/relativeAge.ts")>(join(REPO_ROOT, "src/shared/relativeAge.ts"));
  const { clipPlanLine, foldPlan, planCounts } = await runner.import<typeof import("../src/shared/taskPlan.ts")>(join(REPO_ROOT, "src/shared/taskPlan.ts"));
  const { SCENE_REACH_PX, satellitePhase } = await runner.import<typeof import("../src/renderer/src/character/crew/satellites.ts")>(join(character, "crew/satellites.ts"));
  const outputs = {
    "ios/Infinitary/InfinitaryApp/PhoneSceneData.generated.json": {
      orbit: DEFAULT_ORBIT, remoteTrip: REMOTE_TRIP, program: { branchPx: CONSTELLATION.branchPx, branchDecay: CONSTELLATION.branchDecay, spreadDeg: CONSTELLATION.spreadDeg, rootMarkPx: CONSTELLATION.rootMarkPx, crewGapPx: CONSTELLATION.crewGapPx, widestSpreadDeg: CONSTELLATION.widestSpreadDeg },
      firstmateID: FIRSTMATE_SESSION_ID, dependency: { ...DEPENDENCY_VISUAL, sceneReachPx: SCENE_REACH_PX, phase: satellitePhase(0, 1, 0, true) },
      targets: FM_STATES, durations: EMOTE_DURATION_MS, fidgets: FIDGET_DURATION_MS,
      solids: TIER_SOLIDS, planes: CROWDED_PLANES,
      ring: { startRadiusPx: GROWING_RING.startRadiusPx, remoteShare: CLUSTER_LAYOUT.sizeShare, glyphPx: PLANES_GLYPH_PX,
        remoteGlyphPx: CLUSTER_LAYOUT.crewGlyphPx, crowdedGlyphPx: CLUSTER_LAYOUT.crowdedGlyphPx, crowdedCrew: CLUSTER_LAYOUT.crowdedCrew }, constellations: { orion: ORION, dipper: BIG_DIPPER },
      saturn: SATURN, galaxy: GALAXY, algol: ALGOL, flicker: FLICKER_TUNING, warp: warpData(),
      captain: { ...CAPTAIN_LIGHT, breathMs: CAPTAIN_BREATH_MS },
      wait: { ...WAIT_LIGHT, arcRate: WAIT_ARC_RATE },
    },
    "ios/Infinitary/InfinitaryTests/PhoneSceneTraces.generated.json": REPLY_EMOTES.flatMap((emote) =>
      [0, 0.05, 0.15, 0.25, 0.4, 0.55, 0.7, 0.85, 1].map((progress) => ({ emote, progress, frame: replyFrame(emote, progress) }))),
    "ios/Infinitary/InfinitaryTests/PhoneOrbitSeats.generated.json": orbitSeats(),
    "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/PhoneTaskFacts.generated.json": taskFactReadings(),
  };
  /** INF-1755: the warps' settings, schedule, travel and the very stars the desktop draws, only the ones it reads. */
  function warpData() {
    const fixed = (n: number) => Math.round(n * 1e6) / 1e6;
    const stars = (list: Array<[number, number, number]>, count: number) => list.slice(0, count).map((s) => s.map(fixed));
    return { ...WARP, travelPerSecond: TRAVEL_PER_SECOND, releaseMs: WARP_RELEASE_MS, schedule: WARP_SCHEDULE, lead: WARP_LEAD,
      travel: Array.from(WARP_TRAVEL, fixed), head: stars(WARP_STARS.head, WARP.stars), side: stars(WARP_STARS.side, Math.ceil(WARP.stars * 0.6)),
      inner: stars(WARP_STARS.inner, WARP_STARS.inner.length) };
  }
  /** INF-1926: the desktop crew summary's own facts and words for rows in each state it reads, for the phone's sheet to replay. */
  function taskFactReadings() {
    const now = Date.UTC(2026, 9, 29, 17, 0);
    const min = 60_000;
    const modelNames: Record<string, string> = { "openai-codex/gpt-6.1-terra": "GPT-6.1 Terra", "anthropic/claude-opus-5-5": "Claude Opus 5.5" };
    const modelName = (model: string) => modelNames[model] ?? model.slice(model.indexOf("/") + 1);
    const base: TaskView = {
      id: "t-1887", key: "INF-1887", projectId: "p-inf", parentId: null, kind: "work", title: "Show the crewmate's checks on the phone",
      goal: "Show the crewmate's checks on the phone", priority: 0, status: "active", activity: "running",
      workPosture: { state: "active", reason: "turn" }, closedReason: null, startPolicy: "when-ready",
      flags: { blocked: false, held: false, needsYou: false, ready: false }, blockedBy: [], blocks: [], children: { total: 0, closed: 0 },
      assignee: "crewmate", model: "openai-codex/gpt-6.1-terra", tier: "high", repo: { name: "infinitary", branch: "fm/task-1887" },
      delivery: null, outcomeSummary: null, waitingCardId: null, createdAt: now - 90 * min, updatedAt: now - 2 * min,
      startedAt: now - 80 * min, closedAt: null,
    };
    const log: TaskDetail["activityLog"] = [
      { id: 1, at: now - 80 * min, kind: "dispatched", text: "The crewmate started on GPT-6.1 Terra." },
      { id: 2, at: now - 40 * min, kind: "progress", text: "Read the phone's task row and the desktop's summary." },
      { id: 3, at: now - 12 * min, kind: "pr_opened", text: "Opened pull request #612.", change: { url: "https://github.com/infinitary-labs/infinitary/pull/612", from: 7, to: 23 },
        actions: [{ at: now - 9 * min, text: "Running the phone's unit tests" }] },
      { id: 4, at: now - 3 * min, kind: "steered", text: "You asked it to keep the scene still." },
      { id: 5, at: now - 2 * min, kind: "progress", text: "Checked the waiting task's words.", from: { id: "t-1890", key: "INF-1890" } },
    ];
    const items = (labels: string[], current: number, skipped: number[] = []) => labels.map((label, i) => ({
      label, short: label.split(" ")[0] ?? label, since: now - (labels.length - i) * 5 * min,
      state: skipped.includes(i) ? ("skipped" as const) : i < current ? ("done" as const) : i === current ? ("current" as const) : ("next" as const),
    }));
    const plan = { items: items(["Brief the work", "Port the facts", "Draw the sheet", "Photograph it"], 2), at: now - 6 * min };
    const read: Partial<TaskDetail> = { activityLog: log, said: { at: now - 5 * min, text: "Drawing the sheet's fact strip." }, plan,
      reasoning: { level: "high", lower: "quick" } };
    const pr = { mode: "direct-pr" as const, prNumber: 612, prUrl: "https://github.com/infinitary-labs/infinitary/pull/612", headSha: "c0ffee1" };
    const checks = (states: ForgeCheckState[], extra: object = {}) => ({ headSha: "c0ffee1", items: states.map((state, i) => ({ name: `check-${i + 1}`, state })), absenceDeclared: false, ...extra });
    const cases: Array<[string, Partial<TaskView> & Partial<TaskDetail>]> = [
      ["working with its record, plan and checks", { ...read, delivery: { ...pr, ci: "pending", ciAt: now - min, ciStartedAt: now - 15 * min,
        checks: checks(["pending", "success", "pending"]) } }],
      ["working before its record answers", { delivery: { ...pr, ci: "pending" } }],
      ["waiting for your merge", { ...read, waitingCardId: "card-1", waitingCardMerges: true, workPosture: { state: "idle", reason: "captain" }, activity: "idle",
        delivery: { ...pr, ci: "green", ciAt: now - 4 * min, ciStartedAt: now - 30 * min, ciFinishedAt: now - 16 * min, checks: checks(["success", "success", "skipped"]) } }],
      ["a decision card is ready", { waitingCardId: "card-2", activity: "idle", workPosture: { state: "idle", reason: "captain" } }],
      ["waiting for prerequisites", { requiredAction: { cardId: "card-3", state: "blocked", result: "Waiting for INF-1880" } }],
      ["a required action is ready", { requiredAction: { cardId: "card-3", state: "ready", result: "Ready" } }],
      ["starting", { status: "open", activity: null, workPosture: undefined, startAttempt: { phase: "preparing", since: now - min } }],
      ["could not start", { status: "open", activity: null, workPosture: undefined, startPolicy: "on-request", startNotice: { reason: "No model" } }],
      ["queued behind other work", { status: "open", activity: null, workPosture: undefined, queueWait: { line: "Waiting for a crew place since 9:58 AM", since: now - 62 * min } }],
      ["backlog, blocked", { status: "open", activity: null, workPosture: undefined, startPolicy: "on-request", flags: { blocked: true, held: false, needsYou: false, ready: false } }],
      ["queued, held", { status: "open", activity: null, workPosture: undefined, flags: { blocked: false, held: true, needsYou: false, ready: false } }],
      ["a program waiting on its parts", { status: "open", activity: null, workPosture: undefined, program: true, children: { total: 3, closed: 1 } }],
      ["a program waiting on its one part", { status: "open", activity: null, workPosture: undefined, program: true, children: { total: 1, closed: 0 } }],
      ["backlog on a computer out of reach", { status: "open", activity: null, workPosture: undefined, startPolicy: "on-request",
        executionDeviceId: "dev-mini", place: { name: "Mac mini", where: "on Mac mini", reach: "out-of-reach" } }],
      ["backlog by itself", { status: "open", activity: null, workPosture: undefined, startPolicy: "on-request" }],
      ["waiting for its checks", { ...read, workPosture: { state: "active", reason: "checks" }, delivery: { ...pr, ci: "red", ciStartedAt: now - 50 * min, ciFinishedAt: now - 38 * min,
        checks: checks(["failure", "success", "success"]) } }],
      ["background work", { workPosture: { state: "active", reason: "job" } }],
      ["working on a computer connecting", { executionDeviceId: "dev-mini", place: { name: "Mac mini", where: "on Mac mini", reach: "connecting" } }],
      ["working on a computer out of reach", { executionDeviceId: "dev-mini", place: { name: "Mac mini", where: "on Mac mini", reach: "reconnecting" } }],
      ["interrupted", { activity: "interrupted", workPosture: undefined }],
      ["idle on one task", { activity: "idle", workPosture: { state: "idle", reason: "dependency" }, blockedBy: ["INF-1880"], blockedSince: { "INF-1880": now - 25 * min } }],
      ["idle on two tasks", { activity: "idle", workPosture: { state: "idle", reason: "dependency" }, blockedBy: ["INF-1880", "INF-1881"] }],
      ["idle on a computer that takes no new work", { activity: "idle", workPosture: { state: "idle", reason: "inactive" }, executionDeviceId: "dev-mini",
        place: { name: "Mac mini", where: "on Mac mini", reach: "in-reach", noNewWork: true } }],
      ["idle with an older computer", { activity: "idle", workPosture: { state: "idle", reason: "inactive" }, executionDeviceId: "dev-mini",
        place: { name: "Mac mini", where: "on Mac mini", reach: "out-of-reach", noNewWork: true } }],
      ["idle with no continuing work", { activity: "idle", workPosture: { state: "idle", reason: "inactive" }, model: "anthropic/claude-opus-5-5", tier: "premium",
        ...read, reasoning: { level: "xhigh", lower: "capped" }, delivery: { ...pr, checks: checks([], { absenceDeclared: true }) } }],
      ["idle with no posture", { activity: "idle", workPosture: undefined, model: null, tier: null, ...read }],
      ["paused for access", { activity: "idle", workPosture: { state: "paused", reason: "access" }, delivery: { ...pr, ci: "pending", checks: checks(["success"], { problem: "the host refused the read" }) } }],
      ["done and answered", { status: "done", activity: null, workPosture: undefined, closedReason: "answered", ...read,
        delivery: { ...pr, ci: "merged", reviewVerdict: "pass", reviewRisk: "low" } }],
      ["done with its required action", { status: "done", activity: null, workPosture: undefined, closedReason: "merged", requiredAction: { cardId: "card-4", state: "checked", result: "Installed 1.4" } }],
      ["dropped after failing", { status: "dropped", activity: null, workPosture: undefined, closedReason: "failed", delivery: { ...pr, reviewVerdict: "findings", reviewRisk: "high" } }],
      ["a version its checks were not read for", { delivery: { ...pr, headSha: "d00d1e2", ci: "pending", checks: checks(["success"]) } }],
      ["a reading still incomplete", { delivery: { ...pr, ci: "pending", checks: checks(["success", "neutral"], { complete: false }) } }],
      ["a neutral check", { delivery: { ...pr, ci: "pending", checks: checks(["neutral", "success"]) } }],
      ["no checks reported yet", { delivery: { ...pr, ci: "pending", ciStartedAt: now - 2 * min, checks: checks([]) } }],
      ["a branch with no reading", { delivery: { mode: "local-only", changeLabel: "fm/task-1887", ci: "no-pr" } }],
      ["green with no reading", { delivery: { ...pr, ci: "green", ciStartedAt: now - 3 * 60 * min - 5 * min, ciFinishedAt: now - 30 * 1000 } }],
      ["a run started by hand", { delivery: { mode: "local-only", ci: "no-pr", runChecks: { runId: 7, name: "verify", state: "running", startedAt: now - 70 * min, at: now - min } } }],
      ["a run cancelled by hand", { delivery: { mode: "local-only", runChecks: { runId: 8, name: "verify", state: "cancelled", startedAt: now - 9 * min, finishedAt: now - 4 * min, at: now - 4 * min } } }],
      ["a review blocked", { delivery: { ...pr, ci: "green", reviewVerdict: "blocked" } }],
      ["only another task's rows", { ...read, activityLog: [{ id: 9, at: now - 7 * min, kind: "progress", text: "Its blocker merged.", from: { id: "t-1880", key: "INF-1880" } }], said: null, plan: null }],
      ["only the start line", { ...read, activityLog: [{ id: 1, at: now - 8 * min, kind: "dispatched", text: "The crewmate started." }, { id: 2, at: now - min, kind: "steered", text: "You wrote to it." }], said: null }],
      ["a long plan, clipped", { ...read, plan: { items: items(Array.from({ length: 18 }, (_, i) => `Item ${i + 1} of the long plan`), 2), at: now - 2 * min } }],
      ["a long plan, folded and clipped", { ...read, plan: { items: items(Array.from({ length: 24 }, (_, i) => `Item ${i + 1} of the longer plan`), 9, [3]), at: now - 2 * min } }],
      ["a plan folded", { ...read, plan: { items: items(Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`), 6), at: now - 61 * min } }],
      ["a plan all done", { ...read, plan: { items: items(["Brief", "Build"], 2), at: now - 26 * 60 * min } }],
      ["a plan between items", { ...read, plan: { items: items(["Brief", "Build", "Ship"], 1).map((item) => item.state === "current" ? { ...item, state: "next" as const } : item), at: now } }],
    ];
    /** The summary's line of dots as `PlanDots` builds it: the finished items folded, then the tail past the line's room. */
    function planDots(plan: TaskPlanItem[]) {
      type Dot = { label: string; short: string; state: TaskPlanItem["state"]; group?: number };
      const fold = foldPlan(plan);
      const unclipped: Dot[] = fold
        ? [{ state: "done", short: `${fold.folded.length} done`, label: fold.folded.map((item) => item.label).join(", "), group: fold.folded.length }, ...fold.rest]
        : plan;
      const clip = clipPlanLine(unclipped);
      const nodes: Dot[] = clip
        ? [...clip.shown, { state: clip.later.every((node) => node.state === "done") ? "done" : "next", short: `${clip.later.length} more`,
            label: clip.later.map((node) => node.label).join(", "), group: clip.later.length }]
        : unclipped;
      return nodes.map(({ label, short, state, group }) => ({ label, short, state, group }));
    }
    return { now, modelNames, cases: cases.map(([name, patch]) => {
      const row = { ...base, ...patch } as TaskFactsInput & TaskView;
      const facts = taskFactsOf(row, modelName);
      const shown = facts.plan ? facts.plan.items : [];
      const counts = planCounts(shown);
      const checks = facts.delivery?.checks;
      return { name, row, facts: { ...facts, why: undefined, label: taskStatusLabel(facts.status),
        reasoningWords: facts.reasoning ? reasoningWord(facts.reasoning) : undefined,
        nowAge: facts.now ? feedRelativeAge(facts.now.at, now) : undefined,
        planAge: facts.plan ? feedRelativeAge(facts.plan.at, now) : undefined,
        planWords: facts.plan ? { count: `${counts.done} of ${counts.total}`, skipped: counts.skipped,
          current: counts.current ? counts.current.label : counts.done === counts.total ? "All done" : "Between items" } : undefined,
        planDots: facts.plan ? planDots(shown) : undefined,
        checksWords: checks ? (checks.span ? checksSpanWords(checks.words, checks.span, now) : checks.words) : undefined,
        checksAgo: checks?.span?.finishedAt != null ? checksFinishedAgo(checks.span.finishedAt, now) : undefined } };
    }) };
  }
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
