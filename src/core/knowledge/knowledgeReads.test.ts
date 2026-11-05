import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { KnowledgeStore } from "../storage/knowledgeStore";
import {
  type KnowledgeActor,
  KnowledgeRefusal,
  KnowledgeService,
  type RecordInput,
} from "./knowledgeService";
import { sha256 } from "./sources";

/**
 * What a reader is shown of an entry's surroundings (docs/knowledge.md,
 * "Reading"): a claim's own concepts named as its subject and object, the
 * findings it contradicts as history and as a dispute, its relations in the
 * captain's window, and, for evidence an older build kept from a working
 * copy, whether that file still reads the same where the reader works.
 */

const ALPHA = { id: "repo-alpha", name: "alpha" };
const CAPTAIN: KnowledgeActor = { kind: "firstmate", origin: "captain-turn", canCreate: true };

function fixture(options: { store?: KnowledgeStore } = {}) {
  const root = scratchDir("fm-knowledge-reads-");
  const tasks = new Map([["task-a", { id: "task-a", key: "AL-1", repoId: ALPHA.id }]]);
  let clock = 1_792_000_000_000;
  let given = 0;
  const service = new KnowledgeService({
    ...(options.store ? { store: options.store } : {}),
    projects: {
      get: (id) => (id === ALPHA.id ? { ...ALPHA, path: root } : undefined),
      list: () => [{ ...ALPHA, path: root }],
    },
    tasks: { resolve: (ref) => tasks.get(ref), reports: () => [] },
    gitFacts: async () => ({ commit: null, dirty: false }),
    now: () => (clock += 1000),
    newId: (prefix) => {
      given += 1;
      return `${prefix}-pin${String(given).padStart(3, "0")}`;
    },
  });
  const crew = (cwd?: string): KnowledgeActor => ({
    kind: "crewmate",
    taskId: "task-a",
    repoId: ALPHA.id,
    ...(cwd ? { cwd } : {}),
  });
  let request = 0;
  const kept = async (actor: KnowledgeActor, input: Omit<RecordInput, "requestId">) => {
    request += 1;
    const outcome = await service.record(actor, { requestId: `r${request}`, ...input });
    if (!outcome.committed) throw new Error(outcome.text);
    return outcome.ids[0] as string;
  };
  return { root, service, crew, kept };
}

/** Two concepts, a claim between them, and a second finding that contradicts it. */
async function seed(f: ReturnType<typeof fixture>) {
  const concept = (title: string) =>
    f.kept(f.crew(), {
      action: "publish",
      kind: "concept",
      title,
      explanation: `${title}, as the crew uses it.`,
    });
  const evidence = await concept("Evidence");
  const versions = await concept("Source versions");
  const pins = await f.kept(f.crew(), {
    action: "publish",
    kind: "finding",
    statement: "A source reference pins the inspected version.",
    basis: "inference",
    about: [evidence, versions],
    relationship: { from: evidence, predicate: "pins", to: versions },
    conditions: "On main.",
  });
  const floats = await f.kept(f.crew(), {
    action: "publish",
    kind: "finding",
    statement: "A source reference follows the newest version.",
    basis: "inference",
    about: [evidence],
    conditions: "On main.",
  });
  await f.kept(f.crew(), {
    action: "relate",
    from: floats,
    to: pins,
    type: "contradicts",
    reason: "The release notes say references float.",
  });
  return { evidence, versions, pins, floats };
}

describe("reading around an entry", () => {
  it("names a claim's concepts as its subject and object, and the finding that contradicts it", async () => {
    const f = fixture();
    const { evidence, versions, pins, floats } = await seed(f);
    const near = f.service.neighbors(f.crew(), { id: pins });
    expect(
      near.neighbors.map(({ layer, outgoing, label, other }) => [layer, outgoing, label, other.id]),
    ).toEqual([
      ["about", true, "pins (subject)", evidence],
      ["about", true, "pins (object)", versions],
      ["history", false, "contradicts", floats],
    ]);
    expect(near.total).toBe(3);
    expect(f.service.neighbors(f.crew(), { id: pins, layer: "history" }).total).toBe(1);
    // A contradicting finding disputes both sides; neither decides which is right.
    for (const [id, other] of [
      [pins, floats],
      [floats, pins],
    ] as const) {
      expect(f.service.get(f.crew(), id).summary.status).toMatchObject({
        state: "disputed",
        disputedBy: [other],
      });
    }
    const view = f.service.get(f.crew(), pins);
    expect(view.relations.map(({ type, outgoing, other }) => [type, outgoing, other])).toEqual([
      [
        "contradicts",
        false,
        {
          id: floats,
          kind: "finding",
          title: "A source reference follows the newest version.",
          retired: false,
        },
      ],
    ]);
  });

  it("shows the captain's window a finding's relations with who recorded them", async () => {
    const f = fixture();
    const { pins, floats } = await seed(f);
    const read = f.service.entry({ id: floats });
    if (read.state !== "ready") throw new Error(read.state);
    expect(read.entry.relations).toEqual([
      {
        type: "contradicts",
        reason: "The release notes say references float.",
        other: {
          id: pins,
          kind: "finding",
          title: "A source reference pins the inspected version.",
          retired: false,
        },
        outgoing: true,
        by: "the crewmate on AL-1",
        at: expect.any(Number),
      },
    ]);
    expect(read.entry.standing).toBe("differing");
  });

  it("refuses a revision or a source the reader cannot read, in the same words as one that is absent", async () => {
    const f = fixture();
    const { pins } = await seed(f);
    expect(() => f.service.get(f.crew(), pins, 4)).toThrow(
      new KnowledgeRefusal(`${pins} has no revision 4; its current one is 1.`),
    );
    expect(() => f.service.source(f.crew(), "s-none00")).toThrow(
      new KnowledgeRefusal("No source s-none00 in a collection you can read."),
    );
    expect(() => f.service.get(CAPTAIN, "f-none00")).toThrow(
      new KnowledgeRefusal("No entry f-none00 in a collection you can read."),
    );
  });

  it("checks a file an older build kept against the reader's own working copy", () => {
    const store = KnowledgeStore.inMemory();
    const f = fixture({ store });
    const cwd = scratchDir("fm-knowledge-reads-cwd-");
    const kept = "export const retries = 3;\n";
    writeFileSync(join(f.root, "retry.ts"), kept);
    writeFileSync(join(cwd, "retry.ts"), "export const retries = 5;\n");
    // Citing a file is refused now; this is the shape an older build kept.
    store.insertSource({
      id: "s-file01",
      scope: "captain",
      kind: "file",
      origin: {
        kind: "file",
        project: ALPHA.id,
        path: "retry.ts",
        startLine: 1,
        endLine: 1,
        commit: "a1b2c3d4e5f6a7b8c9d0",
        dirty: false,
        fileDigest: sha256(kept),
      },
      text: "export const retries = 3;",
      digest: sha256("export const retries = 3;"),
      actor: "task:task-a",
      capturedAt: 1_700_000_000_000,
    });
    expect(f.service.source(CAPTAIN, "s-file01").check).toEqual({
      state: "unchanged",
      detail: "retry.ts is unchanged since it was kept",
    });
    expect(f.service.source(f.crew(), "s-file01").check.state).toBe("unchanged");
    expect(f.service.source(f.crew(cwd), "s-file01").check).toEqual({
      state: "changed",
      detail:
        "retry.ts has changed since it was kept (kept at commit a1b2c3d4e5); recheck before relying on it",
    });
  });
});
