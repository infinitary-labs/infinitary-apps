import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FIRSTMATE_CONTRACT_VERSION } from "@core/pi/piResources";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/export-corpus.ts";
import { main as extractDispatchMain } from "../scripts/extract-dispatch-corpus.ts";
import {
  BACKUP_TURNS,
  buildFixture,
  CONTEXT,
  type DispatchRow,
  exportCardCaseIn,
  exportRevisionCaseIn,
  FAILED_WAKE,
  GATE_WAKE,
  NUMERIC_SECRET,
  PLANTED,
  QUOTED_USER_MARKER_WAKE,
  setStamps,
  stamps,
  WHITESPACE_WAKE,
} from "./helpers/corpusCorrections";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The corrected offline export, proven the way the captain's own evidence
 * would exercise it: a fixture userData built with the app's OWN migrations
 * and stores, session transcripts in the shapes `FirstmateAgent` actually
 * writes today, and the REAL export CLI invoked over them. Every assertion
 * reads the exported files - the corpus a training run would consume - not
 * the exporter's source.
 *
 * What the pre-correction exporter got wrong, and what is pinned here:
 *
 *  - an operational drain wears the same context block as a captain turn,
 *    and was exported as a captain turn with no words;
 *  - a captain turn carrying pending wakes (the wake diet) lost them into
 *    the context blob;
 *  - a card was read through pre-P1 reserved action ids, so a settle button
 *    counted as a steer and a host withdrawal as a captain dismissal;
 *  - a card's shape was exported as gold intent;
 *  - a decision never joined the work it was about;
 *  - backup copies of the sessions directory double-counted every turn;
 *  - tool arguments, assistant text and joined strings were never redacted;
 *  - an unstamped turn had nothing saying which contract it was recorded
 *    under.
 *
 * The fixture itself lives in `./helpers/corpusCorrections.ts`.
 */

// Every case runs the real exporter over a freshly built fixture, and the
// card cases run it again over a second one - honest work that outgrows the
// 5s default on a loaded machine (they timed out at load average 40+), so
// the suite states its own budget.
describe("corpus export - the R1 corrections", { timeout: 30_000 }, () => {
  let dir: string;
  let out: string;
  let dispatch: DispatchRow[];
  let raw: { dispatch: string; supervision: string; manifest: string };
  let manifest: {
    dispatch: {
      records: number;
      by_class: Record<string, number>;
      by_contract_version: Record<string, number>;
      unknown_intent: number;
      excluded: { backup_copies: string[]; backup_records: number; copied_entries: number };
    };
    rigor: {
      dispatches: number;
      by_rigor: Record<string, number>;
      reviews: number;
      by_verdict: Record<string, number>;
      by_risk: Record<string, number>;
      reviewed_changes: number;
      cap_hits: number;
      overrides_by_hold: Record<string, number>;
      metrics: Record<string, number | null>;
    };
    exporter_contract_version: string;
  };

  let template: string;
  let fixtureStamps: { clock: number; entryId: number };

  beforeAll(() => {
    setStamps({ clock: Date.parse("2026-09-10T09:00:00.000Z"), entryId: 0 });
    template = scratchDir("infinitary-r1-template-");
    dir = template;
    buildFixture(dir);
    fixtureStamps = stamps();
    out = join(dir, "corpus");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // The real CLI, over the fixture userData.
      expect(main(["--out", out, "--user-data", dir], { isPackaged: false })).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    raw = {
      dispatch: readFileSync(join(out, "dispatch.jsonl"), "utf8"),
      supervision: readFileSync(join(out, "supervision.jsonl"), "utf8"),
      manifest: readFileSync(join(out, "manifest.json"), "utf8"),
    };
  });

  afterAll(() => rmSync(template, { recursive: true, force: true }));

  beforeEach(() => {
    // Export the full immutable corpus once. Each mutation still runs the real
    // CLI against its own filesystem/database, never a shared writable input.
    dir = scratchDir("infinitary-r1-");
    cpSync(template, dir, { recursive: true });
    // Fork headers contain an absolute parent path. Rebase that link too, so
    // a mutation of the copied parent cannot reach the shared template.
    const forkPath = join(dir, "firstmate", "sessions", "2026-09-11T10-00-00-000Z_sess-fork.jsonl");
    const [header, ...entries] = readFileSync(forkPath, "utf8").split("\n");
    const fork = JSON.parse(header ?? "") as { parentSession: string };
    fork.parentSession = join(dir, relative(template, fork.parentSession));
    writeFileSync(forkPath, [JSON.stringify(fork), ...entries].join("\n"));
    out = join(dir, "corpus");
    setStamps(fixtureStamps);
    dispatch = raw.dispatch
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DispatchRow);
    manifest = JSON.parse(raw.manifest);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const turnSaying = (needle: string): DispatchRow => {
    const row = dispatch.find((record) => record.user?.includes(needle));
    if (!row) throw new Error(`no turn saying ${needle}`);
    return row;
  };

  /** Runs the export CLI with its progress lines kept off the test's output. */
  const quietly = <T>(run: () => T): T => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      return run();
    } finally {
      stderr.mockRestore();
    }
  };

  const exportCardCase = (
    user: string,
    cardId: string,
    title: string,
    args: Record<string, unknown>,
    includeResultId = true,
    resultText?: string,
  ): DispatchRow => {
    const { exitCode, row } = quietly(() =>
      exportCardCaseIn(dir, user, cardId, title, args, includeResultId, resultText),
    );
    expect(exitCode).toBe(0);
    if (!row) throw new Error(`no exported case turn saying ${user}`);
    return row;
  };

  it("keeps an operational drain operational, and preserves the wake it carried", () => {
    const ops = dispatch.filter((record) => record.kind === "op");
    expect(ops).toHaveLength(2);
    const drain = ops.find((record) => record.ops.includes(FAILED_WAKE));
    expect(drain).toBeDefined();
    // The wake is carried verbatim, not folded into the context blob.
    expect(drain?.ops).toEqual([FAILED_WAKE]);
    expect(drain?.user).toBeNull();
    expect(drain?.context).toContain("[fm-op] context (not the user)");
    expect(drain?.context).not.toContain("failed: provider timeout");
    expect(drain?.observed_class).toBe("steer");
    // No captain turn may claim the drain's words.
    expect(dispatch.some((record) => record.kind === "user" && record.user === "")).toBe(false);
  });

  it("does not invent captain input from a user marker quoted by a wake", () => {
    const row = dispatch.find((record) => record.ops.includes(QUOTED_USER_MARKER_WAKE));
    expect(row).toBeDefined();
    expect(row?.kind).toBe("op");
    expect(row?.user).toBeNull();
    expect(row?.ops).toEqual([QUOTED_USER_MARKER_WAKE]);
    expect(row?.kind_unknown).toBe(true);
    expect(row?.kind_basis).toBe("ambiguous-framing");
    expect(row?.framing_ambiguity).toBe("user-boundary");
    expect(row?.label).toMatchObject({ gold_class: null, unknown: true });
    expect(row?.framed_text).toBe(
      `${CONTEXT.replace(PLANTED.contextLine, "Bearer [redacted]")}\n\n${QUOTED_USER_MARKER_WAKE}`,
    );
  });

  it("reads a captain turn that carried pending wakes as mixed, keeping both halves", () => {
    const mixed = turnSaying("What is going on with the rollout?");
    expect(mixed.kind).toBe("mixed");
    expect(mixed.ops).toEqual([GATE_WAKE]);
    expect(mixed.user).toBe("What is going on with the rollout?");
    expect(mixed.context).toContain("repos:");
    // `emote` is auxiliary: it neither carries a class nor makes the turn
    // unclassifiable, so reading alone still reads as the answer it was.
    expect(mixed.observed_class).toBe("answer");
  });

  it("preserves an fm-op paragraph inside the captain's words", () => {
    const row = turnSaying("Analyze this:");
    expect(row.kind).toBe("user");
    expect(row.ops).toEqual([]);
    expect(row.user).toBe("Analyze this:\n\n[fm-op] sample log from the captain.");
    expect(row.kind_unknown).toBe(false);
  });

  it("keeps an ambiguous fm-op paragraph inside context", () => {
    const row = turnSaying("What did the note say?");
    expect(row.kind).toBe("user");
    expect(row.ops).toEqual([]);
    expect(row.context).toContain("[fm-op] pasted note text\nstill context");
    expect(row.ambiguous_wakes).toEqual([
      expect.stringContaining("[fm-op] pasted note text\nstill context"),
    ]);
    expect(row.kind_basis).toBe("ambiguous-context");
    expect(row.kind_unknown).toBe(true);
  });

  it("keeps post-self-source title text in ambiguous context", () => {
    const row = turnSaying("What title is open?");
    expect(row.kind).toBe("user");
    expect(row.ops).toEqual([]);
    expect(row.context).toContain('[fm-op] text embedded after self-source"');
    expect(row.ambiguous_wakes).toEqual([
      expect.stringContaining('[fm-op] text embedded after self-source"'),
    ]);
    expect(row.kind_basis).toBe("ambiguous-context");
    expect(row.kind_unknown).toBe(true);
  });

  it("preserves captain whitespace after the user boundary", () => {
    const row = dispatch.find((record) => record.user === "  pasted sample  ");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("mixed");
    expect(row?.context).toContain("repos:  \n");
    expect(row?.ops).toEqual([WHITESPACE_WAKE]);
    expect(row?.user).toBe("  pasted sample  ");
  });

  it("joins the current decision to the work it is about, through the record's own timeline", () => {
    const asked = turnSaying("Is it ready?");
    const [card] = asked.outcome.cards;
    expect(card).toMatchObject({
      card_id: "card-t-work-1",
      task_id: "t-work",
      task_via: "task-event",
      resolution: "acted",
      resolved_by: "captain",
    });
    // The work rides the record too, not just the card id.
    expect(asked.outcome.tasks.map((task) => task.task_id)).toContain("t-work");
    expect(asked.outcome.tasks.every((task) => task.found)).toBe(true);
    // A row dispatched before delivery rigor existed (no shape, or a shape
    // with no rigor) exports as the quick work it was, never as unknown
    // (delivery rigor phase 2).
    const work = asked.outcome.tasks.find((task) => task.task_id === "t-work");
    expect(work?.rigor).toBe("quick");
    // ...and carries no review facts, because none were ever recorded on
    // it: null, never a guessed verdict (delivery rigor phase 3).
    expect(work).toMatchObject({ review_of: null, review_verdict: null, review_risk: null });
  });

  it("carries the review facts on a reviewed builder and the builder on its review task (phase 3)", () => {
    const asked = turnSaying("Where does the meter review stand?");
    const builder = asked.outcome.tasks.find((task) => task.task_id === "t-build");
    const review = asked.outcome.tasks.find((task) => task.task_id === "t-review");
    expect(builder).toMatchObject({
      found: true,
      rigor: "reviewed",
      review_of: null,
      review_verdict: "findings",
      review_risk: "medium",
    });
    expect(review).toMatchObject({
      found: true,
      rigor: "quick",
      review_of: "t-build",
      review_verdict: null,
      review_risk: null,
    });
  });

  it("resolves credential-bearing card lineage before redacting the finished record", () => {
    const credentialTitle = `Credential API_KEY=${PLANTED.lineageTitle}`;
    const args = {
      task_id: "t-work",
      title: credentialTitle,
      body: "<p>Revised credential-bearing evidence.</p>",
      actions: [
        {
          id: "merge-credential",
          label: "Merge",
          default: true,
          effect: { kind: "merge", after: "close" },
        },
      ],
    };
    const byId = exportCardCase(
      "Show the credential-title card by id.",
      "card-t-work-credential-title",
      credentialTitle,
      args,
    );
    expect(byId.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-credential-title",
      found: true,
      joined_via: "tool-result-id",
      task_id: "t-work",
      revisions: 1,
      actions: [{ id: "merge-credential", effect: { kind: "merge", after: "close" } }],
      resolution: "acted",
      captain_contact: "settle",
    });

    const byTitle = exportCardCase(
      "Show the credential-title card without an id.",
      "card-t-work-credential-title",
      credentialTitle,
      args,
      false,
    );
    expect(byTitle.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-credential-title",
      found: true,
      joined_via: "title",
      task_id: "t-work",
      revisions: 1,
      resolution: "acted",
    });

    const resultCredential = exportCardCase(
      "Recover the id after a credential-bearing result.",
      "card-fm-result-credential",
      "Credential result card",
      {
        task_id: "t-work",
        title: "Credential result card",
        body: "<p>Result carried a credential.</p>",
        actions: [
          {
            id: "open-result",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
      true,
      `Card shown: Authorization: Bearer ${PLANTED.lineageResult} (card-fm-result-credential)`,
    );
    expect(resultCredential.outcome.cards[0]).toMatchObject({
      card_id: "card-fm-result-credential",
      found: true,
      joined_via: "tool-result-id",
      task_id: "t-work",
      actions: [{ id: "open-result", effect: { kind: "open", target: "settings" } }],
      resolution: "acted",
      captain_contact: "open",
    });

    for (const cardId of ["card-t-work-credential-title", "card-fm-result-credential"]) {
      const exported = readFileSync(join(dir, `corpus-${cardId}`, "dispatch.jsonl"), "utf8");
      expect(exported).not.toContain(PLANTED.lineageTitle);
      expect(exported).not.toContain(PLANTED.lineageResult);
      expect(exported).toContain("[redacted");
    }
  });

  it("reads a settle effect as a settle, never as a steer", () => {
    const [card] = turnSaying("Is it ready?").outcome.cards;
    expect(card?.chosen_action).toBe("merge-pr");
    expect(card?.chosen_effect).toMatchObject({ kind: "merge", after: "close" });
    expect(card?.captain_contact).toBe("settle");
    expect(raw.dispatch).not.toContain('"captain_contact":"steer"');
    // The supervision half reads the same card the same way.
    const escalations = raw.supervision
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { card: { captain_contact?: string } | null });
    expect(escalations[0]?.card?.captain_contact).toBe("settle");
  });

  it("separates the escalation shape from the resolution-time action shape", () => {
    const records = raw.supervision
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            card: {
              card_id: string;
              title?: string;
              body?: string;
              decision?: boolean;
              actions?: Array<{ id?: string }>;
              description_version?: {
                requested_at: number;
                selected_at: number | null;
                basis: string;
                fallback: string | null;
              };
              resolution_actions?: Array<{
                id?: string;
                effect?: { kind?: string; mode?: string };
              }>;
              resolution_version?: {
                requested_at: number | null;
                selected_at: number | null;
                basis: string;
              };
              chosen_effect?: { kind?: string; mode?: string } | null;
              captain_contact?: string;
              resolution?: string;
            } | null;
            label: {
              confidence: string;
              unknown: boolean;
              basis: string;
              evidence: string[];
            };
          },
      );
    const byCard = new Map(records.map((record) => [record.card?.card_id, record]));

    const revised = byCard.get("card-t-work-supervision-revised");
    expect(revised?.card).toMatchObject({
      title: "Original escalation",
      body: "<p>Original evidence.</p>",
      decision: false,
      actions: [],
      description_version: {
        requested_at: 50,
        selected_at: 50,
        basis: "revision",
        fallback: null,
      },
      resolution_actions: [{ id: "merge-revised", effect: { kind: "merge", after: "close" } }],
      resolution_version: { requested_at: 70, selected_at: 70, basis: "current" },
      chosen_effect: { kind: "merge", after: "close" },
      resolution: "acted",
    });
    expect(revised?.label).toMatchObject({
      confidence: "corroborated",
      unknown: false,
      basis: "card-resolution",
    });
    expect(revised?.label.evidence).toEqual([
      expect.stringContaining("showed a note; its resolution-time decision was answered"),
    ]);

    expect(byCard.get("card-t-work-1")?.card?.description_version).toEqual({
      requested_at: 19,
      selected_at: 20,
      basis: "current",
      fallback: "creation",
    });

    const open = byCard.get("card-t-work-supervision-open");
    expect(open?.card).toMatchObject({
      title: "Open escalation",
      actions: [{ id: "answer" }],
      resolution: "open",
      resolution_version: { requested_at: null, selected_at: null, basis: "open" },
      chosen_effect: null,
      captain_contact: "none",
    });
    expect(open?.card?.resolution_actions).toBeUndefined();
  });

  it("never reads an emitter's withdrawal as the captain's dismissal", () => {
    const [card] = turnSaying("Anything else?").outcome.cards;
    expect(card).toMatchObject({ resolution: "retired", resolved_by: "firstmate" });
    const escalations = raw.supervision
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { label: { confidence: string } });
    // A withdrawn card contradicts nothing: nobody ever answered it.
    expect(escalations[1]?.label.confidence).toBe("observed");
  });

  it("reads current colliding action ids only by their declared effect", () => {
    const row = exportCardCase(
      "Use the current action.",
      "card-t-work-3",
      "Current free-form action",
      {
        task_id: "t-work",
        title: "Current free-form action",
        body: "<p>Choose.</p>",
        actions: [{ id: "open-settings", label: "Send this guidance", default: true }],
      },
    );
    const [card] = row.outcome.cards;
    expect(card).toMatchObject({
      chosen_action: "open-settings",
      chosen_effect: null,
      effect_source: null,
      author: "firstmate",
      captain_contact: "none",
    });

    const crewRow = exportCardCase(
      "Use the crewmate action.",
      "card-t-work-6",
      "Crewmate free-form action",
      {
        task_id: "t-work",
        title: "Crewmate free-form action",
        body: "<p>Choose.</p>",
        actions: [{ id: "use-postgres", label: "Use Postgres", default: true }],
      },
    );
    expect(crewRow.outcome.cards[0]).toMatchObject({
      chosen_action: "use-postgres",
      chosen_effect: null,
      effect_source: null,
      author: "crewmate",
      captain_contact: "steer",
    });
  });

  it("uses the card version each emit turn actually showed", () => {
    const { exitCode, early, current, at } = quietly(() => exportRevisionCaseIn(dir));
    expect(exitCode).toBe(0);
    // The early version was shown and seen before the current turn, and replaced after it.
    expect(at.early).toBeLessThan(at.earlyObserved);
    expect(at.earlyObserved).toBeLessThan(at.currentTurn);
    expect(at.currentTurn).toBeLessThan(at.replaced);
    if (!early || !current) throw new Error("missing revised card turns");
    expect(early.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-revised",
      joined_via: "title",
      actions_version: "revision",
      body: "<p>Original choice.</p>",
      actions: [{ id: "choose-a" }],
      resolution: "retired",
      captain_contact: "withdrawn",
    });
    expect(current.outcome.cards[0]).toMatchObject({
      joined_via: "tool-result-id",
      actions_version: "current",
      body: "<p>Current choice.</p>",
      actions: [{ id: "merge-current", effect: { kind: "merge", after: "close" } }],
      resolution: "acted",
      chosen_effect: { kind: "merge", after: "close" },
      captain_contact: "settle",
    });
  });

  it("lets a current declared close action outrank the chrome dismissal id", () => {
    const row = exportCardCase(
      "Use the declared close action.",
      "card-t-work-close",
      "Current close action",
      {
        task_id: "t-work",
        title: "Current close action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(row.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "acted",
      chosen_effect: { kind: "open", target: "settings" },
      captain_contact: "open",
    });
  });

  it("distinguishes a declared close action from chrome dismissal", () => {
    const dismissed = exportCardCase(
      "Dismiss the close-action card.",
      "card-t-work-close-dismissed",
      "Dismissed close action",
      {
        task_id: "t-work",
        title: "Dismissed close action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(dismissed.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "dismissed",
      chosen_effect: null,
      captain_contact: "dismissed",
    });
    expect(dismissed.label.confidence).toBe("contradicted");

    const acted = exportCardCase(
      "Use the taskless close action.",
      "card-fm-close-acted",
      "Taskless close action",
      {
        standalone: true,
        title: "Taskless close action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(acted.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "acted",
      resolved_by: "captain",
      chosen_effect: { kind: "open", target: "settings" },
      captain_contact: "open",
    });

    const tasklessDismissed = exportCardCase(
      "Dismiss the taskless close action.",
      "card-fm-close-dismissed",
      "Taskless dismissed close",
      {
        standalone: true,
        title: "Taskless dismissed close",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(tasklessDismissed.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "dismissed",
      resolved_by: "captain",
      chosen_effect: null,
      captain_contact: "dismissed",
    });
  });

  it("lets current declared sentinel ids outrank their host meanings", () => {
    const dismissedAction = exportCardCase(
      "Use the declared dismissed action.",
      "card-t-work-dismissed-action",
      "Declared dismissed action",
      {
        task_id: "t-work",
        title: "Declared dismissed action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "dismissed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(dismissedAction.outcome.cards[0]).toMatchObject({
      chosen_action: "dismissed",
      resolution: "acted",
      chosen_effect: { kind: "open", target: "subscriptions" },
      captain_contact: "open",
    });

    const chromeDismissed = exportCardCase(
      "Dismiss the declared dismissed action.",
      "card-t-work-dismissed-chrome",
      "Chrome-dismissed declared action",
      {
        task_id: "t-work",
        title: "Chrome-dismissed declared action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "dismissed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(chromeDismissed.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "dismissed",
      chosen_effect: null,
      captain_contact: "dismissed",
    });

    const withdrawnAction = exportCardCase(
      "Use the declared withdrawn action.",
      "card-fm-withdrawn-acted",
      "Declared withdrawn action",
      {
        standalone: true,
        title: "Declared withdrawn action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "withdrawn",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(withdrawnAction.outcome.cards[0]).toMatchObject({
      chosen_action: "withdrawn",
      resolution: "acted",
      chosen_effect: { kind: "open", target: "settings" },
      captain_contact: "open",
    });

    const retiredWithdrawn = exportCardCase(
      "Withdraw the declared withdrawn action.",
      "card-fm-withdrawn-retired",
      "Retired withdrawn action",
      {
        standalone: true,
        title: "Retired withdrawn action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "withdrawn",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(retiredWithdrawn.outcome.cards[0]).toMatchObject({
      chosen_action: "withdrawn",
      resolution: "retired",
      chosen_effect: null,
      captain_contact: "withdrawn",
    });

    const closedAction = exportCardCase(
      "Use the taskless declared closed action.",
      "card-fm-closed-acted",
      "Declared closed action",
      {
        standalone: true,
        title: "Declared closed action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "closed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(closedAction.outcome.cards[0]).toMatchObject({
      chosen_action: "closed",
      resolution: "acted",
      resolved_by: "captain",
      chosen_effect: { kind: "open", target: "subscriptions" },
      captain_contact: "open",
    });

    const retiredClosed = exportCardCase(
      "Withdraw the taskless declared closed action.",
      "card-fm-closed-retired",
      "Retired closed action",
      {
        standalone: true,
        title: "Retired closed action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "closed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(retiredClosed.outcome.cards[0]).toMatchObject({
      chosen_action: "closed",
      resolution: "retired",
      resolved_by: "firstmate",
      chosen_effect: null,
      captain_contact: "withdrawn",
    });
  });

  it("lets current declared actions outrank withdrawal-shaped ids", () => {
    const landed = exportCardCase(
      "Use the declared landed action.",
      "card-t-work-landed-action",
      "Current landed action",
      {
        task_id: "t-work",
        title: "Current landed action",
        body: "<p>Land this work.</p>",
        actions: [
          {
            id: "landed",
            label: "Land",
            default: true,
            effect: { kind: "merge", after: "close" },
          },
        ],
      },
    );
    expect(landed.outcome.cards[0]).toMatchObject({
      chosen_action: "landed",
      resolution: "acted",
      chosen_effect: { kind: "merge", after: "close" },
      captain_contact: "settle",
    });

    const closed = exportCardCase(
      "Use the declared closed action.",
      "card-t-work-closed-action",
      "Current closed action",
      {
        task_id: "t-work",
        title: "Current closed action",
        body: "<p>Send guidance.</p>",
        actions: [{ id: "closed", label: "Send guidance", default: true }],
      },
    );
    expect(closed.outcome.cards[0]).toMatchObject({
      chosen_action: "closed",
      resolution: "acted",
      chosen_effect: null,
      author: "crewmate",
      captain_contact: "steer",
    });

    const bare = exportCardCase(
      "Show the bare landed withdrawal.",
      "card-t-work-bare-landed",
      "Bare landed withdrawal",
      {
        task_id: "t-work",
        title: "Bare landed withdrawal",
        body: "<p>Withdrawn.</p>",
      },
    );
    expect(bare.outcome.cards[0]).toMatchObject({
      chosen_action: "landed",
      resolution: "retired",
      chosen_effect: null,
      captain_contact: "withdrawn",
    });
  });

  it("reads a legacy keep action as a close control, never a steer", () => {
    const row = exportCardCase(
      "Read the historical close control.",
      "card-t-work-legacy-keep",
      "Historical keep control",
      {
        kind: "decision",
        task_id: "t-work",
        title: "Historical keep control",
        body: "<p>Old decision.</p>",
        actions: [{ id: "keep", label: "Keep", default: true }],
      },
    );
    expect(row.outcome.cards[0]).toMatchObject({
      chosen_action: "keep",
      resolution: "dismissed",
      chosen_effect: null,
      captain_contact: "dismissed",
    });
  });

  it("preserves legacy interpretation only for source-proven historical cards", () => {
    const row = exportCardCase(
      "Read the historical action.",
      "card-t-work-4",
      "Historical reserved action",
      {
        kind: "decision",
        task_id: "t-work",
        title: "Historical reserved action",
        body: "<p>Choose.</p>",
        actions: [{ id: "open-settings", label: "Open settings", default: true }],
      },
    );
    const [card] = row.outcome.cards;
    expect(card).toMatchObject({
      chosen_action: "open-settings",
      chosen_effect: { kind: "open", target: "settings" },
      effect_source: "legacy-id",
      captain_contact: "open",
    });
  });

  it("keeps a captain-confirmed duplicate closure as a withdrawal", () => {
    const row = exportCardCase("Show the repeated note.", "card-t-work-5", "Repeated note", {
      task_id: "t-work",
      title: "Repeated note",
      body: "<p>This repeats an earlier card.</p>",
    });
    const [card] = row.outcome.cards;
    expect(card).toMatchObject({
      chosen_action: "duplicate",
      resolution: "retired",
      resolved_by: "captain",
      captain_contact: "withdrawn",
    });
  });

  it("uses a taskless card's linked decision actor", () => {
    const row = exportCardCase(
      "Show the withdrawn proposal.",
      "card-fm-withdrawn",
      "Withdrawn proposal",
      {
        standalone: true,
        title: "Withdrawn proposal",
        body: "<p>Obsolete.</p>",
        actions: [{ id: "proceed", label: "Proceed", default: true }],
      },
    );
    expect(row.outcome.cards[0]).toMatchObject({
      chosen_action: "proceed",
      resolution: "retired",
      resolved_by: "firstmate",
      captain_contact: "withdrawn",
    });
  });

  it("reports title provenance independently from task-event provenance", () => {
    const row = exportCardCase(
      "Show the title-only result.",
      "card-t-work-title",
      "Title-only historical result",
      {
        task_id: "t-work",
        title: "Title-only historical result",
        body: "<p>Choose.</p>",
        actions: [{ id: "accept", label: "Accept", default: true }],
      },
      false,
    );
    expect(row.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-title",
      joined_via: "title",
      task_id: "t-work",
      task_via: "task-event",
    });
  });

  it("keeps a card-shape class explicitly weak, with no gold intent", () => {
    const asked = turnSaying("Is it ready?");
    expect(asked.observed_class).toBe("ask");
    expect(asked.label).toMatchObject({ gold_class: null, unknown: true, basis: "card-shape" });
    expect(asked.label.evidence.join(" ")).toContain("no gold intent");
    // A turn that exercised a move keeps its (still weak) gold class.
    const spawn = turnSaying("Get the nimbus fix shipped.");
    expect(spawn.label).toMatchObject({ gold_class: "spawn", unknown: false, basis: "tool" });
    expect(manifest.dispatch.unknown_intent).toBeGreaterThan(0);
  });

  it(`excludes the backup copies of the sessions directory - exactly ${BACKUP_TURNS} turns`, () => {
    // What a run that read every file on disk would have counted.
    const onDisk = dispatch.length + manifest.dispatch.excluded.backup_records;
    expect(manifest.dispatch.excluded.backup_records).toBe(BACKUP_TURNS);
    expect(onDisk - dispatch.length).toBe(BACKUP_TURNS);
    expect(manifest.dispatch.excluded.backup_copies).toHaveLength(1);
    expect(manifest.dispatch.excluded.backup_copies[0]).toContain("sessions-backup");
    // And no turn is in the corpus twice.
    const ids = dispatch.map((record) => `${record.kind}:${record.user}:${record.ops.join()}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads a forked session's copied history once, as history", () => {
    expect(manifest.dispatch.excluded.copied_entries).toBeGreaterThan(0);
    expect(dispatch.filter((row) => row.user === "Get the nimbus fix shipped.")).toHaveLength(1);
    const fork = turnSaying("Carry on from the fork.");
    expect(fork.contract).toEqual({ version: "1.1", prompt_sha: "sha-old" });
    expect(fork.model).toBe("xai/grok-4.6");
  });

  it("keeps every input at the contract version it was recorded under", () => {
    const stamped = turnSaying("Is it ready?");
    expect(stamped.contract).toEqual({ version: "1.1", prompt_sha: "sha-old" });
    const unstamped = turnSaying("Old question.");
    expect(unstamped.contract).toBeNull();
    // The version this checkout serves is reported once, as the exporter's
    // own, and is never stamped onto a historical turn.
    expect(manifest.exporter_contract_version).toBe(FIRSTMATE_CONTRACT_VERSION);
    expect(manifest.dispatch.by_contract_version.unstamped).toBeGreaterThan(0);
    expect(manifest.dispatch.by_contract_version["1.1"]).toBeGreaterThan(0);
    expect(manifest.dispatch.by_contract_version[FIRSTMATE_CONTRACT_VERSION]).toBeUndefined();
    expect(raw.dispatch).not.toContain(`"version":"${FIRSTMATE_CONTRACT_VERSION}"`);
  });

  it("rolls up how carefully the fleet shipped, scored by the one home (phase 4)", () => {
    const rigor = manifest.rigor;
    // One shaped row SHIPPED work here, and it shipped reviewed. The review
    // task is shaped too and is deliberately not in the mix: it read that
    // change rather than shipping one, so counting it would count the
    // reading as a shipment.
    expect(rigor.by_rigor).toEqual({ reviewed: 1 });
    expect(rigor.dispatches).toBe(1);
    // One verdict, on one change, with the risk it stated.
    expect(rigor.reviews).toBe(1);
    expect(rigor.by_verdict).toEqual({ findings: 1 });
    expect(rigor.by_risk).toEqual({ medium: 1 });
    expect(rigor.reviewed_changes).toBe(1);
    expect(rigor.cap_hits).toBe(0);
    // Each override the captain's words declared, per hold kind it passed:
    // two declared, one taken back between them (INF-484 move 8).
    expect(rigor.overrides_by_hold).toEqual({ checks: 2, waits: 1 });
    // The numbers are the metric module's, not a second implementation: the
    // findings are counted off the reviewer's own report, and the CI rounds
    // are charged to the one direct-pr change that opened a pull request.
    expect(rigor.metrics).toMatchObject({
      rigor_share_reviewed: 1,
      rigor_share_quick: 0,
      review_rounds_per_change: 1,
      review_verdict_share_findings: 1,
      review_verdict_share_pass: 0,
      findings_auto_fix_per_change: 1,
      findings_ask_user_per_change: 1,
      findings_ask_user_rate: 0.5,
      ci_rounds_per_change: 2,
      rigor_cap_hits: 0,
      hold_overrides: 2,
    });
    // No completion card settled anything here, so the evidence question
    // has nothing to answer - never a zero share.
    expect(rigor.metrics.evidence_headings_share).toBeNull();
  });

  it("redacts database joins in the standalone dispatch export", () => {
    const standalone = join(dir, "dispatch-standalone.jsonl");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(extractDispatchMain(["--out", standalone, "--user-data", dir])).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    const text = readFileSync(standalone, "utf8");
    expect(text).not.toContain("PLANTEDFOUR");
    expect(text).not.toContain(PLANTED.structured);
    expect(text).not.toContain(PLANTED.cookie);
    expect(text).not.toContain(PLANTED.session);
    expect(text).not.toContain(PLANTED.privateKey);
    expect(text).toContain("[redacted");
  });

  it("lets no planted credential survive in any exported field", () => {
    for (const [where, secret] of Object.entries(PLANTED)) {
      const marker = secret.replace(
        /^(sk-proj-|ghp_|xai-|sk-ant-api03-|Bearer |AKIA|Authorization: )/,
        "",
      );
      for (const [file, text] of Object.entries(raw)) {
        expect(`${where} in ${file}: ${text.includes(marker) ? "LEAKED" : "clean"}`).toBe(
          `${where} in ${file}: clean`,
        );
      }
    }
    for (const text of Object.values(raw)) {
      expect(text).not.toContain("PLANTEDBEARERNESTED");
      expect(text).not.toContain("PLANTEDBEARERJOINED");
      expect(text).not.toContain("PLANTEDCOOKIENESTED");
      expect(text).not.toContain("PLANTEDCOOKIEJOINED");
      expect(text).not.toContain("PLANTEDCREDENTIALSNESTED");
      expect(text).not.toContain("PLANTEDCREDENTIALJOINED");
      expect(text).not.toContain("PLANTEDOAUTHNESTED");
      expect(text).not.toContain("PLANTEDOAUTHJOINED");
      expect(text).not.toContain("PLANTEDSHELLNESTED");
      expect(text).not.toContain("PLANTEDESCAPEDNESTED");
      expect(text).not.toContain("PLANTEDSHELLJOINED");
    }
    // The redaction happened, rather than the fields being dropped.
    expect(raw.dispatch).not.toContain(`"password":${NUMERIC_SECRET}`);
    expect(raw.dispatch).toContain('"password":"[redacted credential]"');
    expect(raw.dispatch).toContain("[redacted");
    expect(raw.supervision).toContain("[redacted");
  });
});
