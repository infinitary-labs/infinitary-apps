import type {
  KnowledgeDirection,
  KnowledgeDirectionArgs,
  KnowledgeDirectionChange,
  KnowledgeDirectionChanged,
  KnowledgeDirectionRead,
  KnowledgeDirectionRow,
  KnowledgeDirections,
  KnowledgeDirectionsArgs,
} from "@shared/knowledge";
import type { AppDatabase } from "../storage/db";
import type { DirectionRow } from "../storage/knowledgeStore";
import {
  canonical,
  clean,
  type KnowledgeActor,
  MAX,
  PRIVATE_SCOPE,
  refuse,
  WINDOW,
} from "./access";
import { pageOf } from "./browse";
import type { KnowledgeHandle } from "./knowledgeService";

/**
 * Standing directions (primitives/standing-directions.md): the captain's
 * instructions and the crew's advice, kept in their own tables beside the
 * knowledge collection and never a search candidate. Every turn receives
 * the complete set that applies to it; the captain's window and the first
 * mate's app_change change them through one path. The service lends this
 * owner its one store.
 */

/**
 * The captain scope's name where directions are listed (INF-1217): it
 * applies in every project, and only the first mate reads it, never a
 * crewmate (`StandingDirections.visible`). The Knowledge panel's Project
 * filter says the same (`src/panels/knowledge/words.ts`).
 */
export const CAPTAIN_SCOPE_NAME = "Everywhere, first mate only";

export class StandingDirections {
  constructor(private readonly handle: KnowledgeHandle) {}

  /**
   * Carry only the remaining active directions before any agent starts.
   * There is no archive or old revision import. Once kept, the old tables
   * are removed. A quit between databases retries the same current rows;
   * a conflicting destination stops startup rather than losing a direction.
   */
  carry(db: AppDatabase): void {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories'").get()) return;
    const rows = db
      .prepare(`SELECT id, scope, content AS text, origin,
      created_at AS createdAt, updated_at AS updatedAt
      FROM memories WHERE kind = 'preference' AND status = 'active' ORDER BY created_at, id`)
      .all() as Omit<DirectionRow, "revision" | "retired">[];
    if (rows.length) {
      const store = this.handle.open();
      store.transaction(() => {
        for (const row of rows) {
          const next: DirectionRow = { ...row, revision: 1, retired: false };
          const previous = store.directions().find((entry) => entry.id === row.id);
          if (previous) {
            if (canonical(previous) !== canonical(next))
              throw new Error(
                "A standing direction conflicts with Knowledge. No original direction was removed.",
              );
          } else {
            store.saveDirection(
              next,
              "publish",
              "Carried from the active direction at notes retirement.",
            );
          }
        }
      });
    }
    db.transaction(() => db.exec("DROP TABLE memory_revisions; DROP TABLE memories;"))();
  }

  /** Full authoritative set, never shortened to a search or formatting budget. */
  standing(actor: KnowledgeActor): KnowledgeDirectionRow[] {
    return this.handle
      .open()
      .directions()
      .filter((row) => !row.retired && this.visible(actor, row))
      .map((row) => this.row(row));
  }

  /**
   * The directions that apply to one project's work, everywhere ones
   * included: what the computer question reads (`computerChoice.ts`). The
   * everywhere ones otherwise reach only the first mate.
   */
  applying(repoId: string): KnowledgeDirectionRow[] {
    const crew: KnowledgeActor = { kind: "crewmate", taskId: "", repoId };
    return this.handle
      .open()
      .directions()
      .filter((row) => !row.retired && (row.scope === PRIVATE_SCOPE || this.visible(crew, row)))
      .map((row) => this.row(row));
  }

  /** A paged browser view of the authoritative directions. */
  page(args: KnowledgeDirectionsArgs): KnowledgeDirections {
    return this.handle.browsing((store) => {
      const scope = args.scope === "all" ? "all" : this.scope(args.scope);
      const query = args.query?.trim().toLocaleLowerCase() ?? "";
      const all = (store?.directions() ?? [])
        .filter((row) => !row.retired)
        .filter((row) => this.known(row.scope))
        .filter((row) => scope === "all" || row.scope === scope)
        .filter((row) => !query || row.text.toLocaleLowerCase().includes(query))
        .sort(
          (a, b) =>
            Number(b.origin === "captain-turn") - Number(a.origin === "captain-turn") ||
            b.updatedAt - a.updatedAt ||
            a.id.localeCompare(b.id),
        );
      const { rows, page } = pageOf(all, args.page);
      return {
        state: "ready",
        scope,
        page,
        total: all.length,
        rows: rows.map((row) => this.row(row)),
      };
    });
  }

  /** One direction whole, with a page of its history, when `actor` may read it. */
  read(args: KnowledgeDirectionArgs, actor: KnowledgeActor = WINDOW): KnowledgeDirectionRead {
    return this.handle.browsing((store): KnowledgeDirectionRead => {
      const row = store?.directions().find((entry) => entry.id === args.id);
      if (!store || !row || !this.known(row.scope) || !this.visible(actor, row))
        return { state: "missing" };
      const history = store.directionHistory(row.id);
      const { rows, page } = pageOf(history, args.page);
      return {
        state: "ready",
        direction: {
          ...this.row(row),
          retired: row.retired,
          createdAt: row.createdAt,
          history: rows,
          page,
          total: history.length,
        },
      };
    });
  }

  /**
   * One change to a standing direction, the app action catalog's `direction`
   * line (`inf:knowledge:direction:set`): the captain's window and the first
   * mate's app_change ask it alike, through the dispatcher's one path, which
   * checks who may and writes the feed line (INF-638, the captain: "why not
   * just give first mate a tool to freely read and write standing
   * directions, and then rely on the agent's judgment on when/how to do
   * it?"). Every direction is his instruction, and its history keeps the
   * reason. A refusal throws, as every catalog change's does.
   */
  change(change: KnowledgeDirectionChange): KnowledgeDirectionChanged {
    const store = this.handle.open();
    const id = change.id?.replace(/^d:/, "") ?? this.handle.newId("d");
    const previous = store.directions().find((row) => row.id === id);
    if (change.op === "add" && previous)
      refuse("This direction already exists; revise it instead.");
    if (change.op !== "add" && !previous) refuse(`No direction d:${id} exists.`);
    if (
      previous &&
      change.op !== "add" &&
      change.expectedRevision !== undefined &&
      change.expectedRevision !== previous.revision
    )
      refuse(`d:${id} is at revision ${previous.revision} now; read it again before changing it.`);
    const scope =
      change.op === "add"
        ? this.scope(change.scope ?? PRIVATE_SCOPE)
        : (previous?.scope ?? PRIVATE_SCOPE);
    const text =
      change.op === "retire"
        ? (previous?.text ?? "")
        : clean(change.text, "text", MAX.explanation, true);
    const reason = clean(change.reason, "reason", MAX.reason, true);
    const at = this.handle.now();
    const next: DirectionRow = {
      id,
      scope,
      text,
      origin: "captain-turn",
      revision: (previous?.revision ?? 0) + 1,
      retired: change.op === "retire",
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    store.transaction(() => {
      const current = store.directions().find((row) => row.id === id);
      if (current?.revision !== previous?.revision)
        refuse("The direction changed. Read it again before writing.");
      store.saveDirection(next, change.op === "add" ? "publish" : change.op, reason);
    });
    this.handle.deps.changed?.();
    return { op: change.op, direction: this.row(next) };
  }

  private visible(actor: KnowledgeActor, row: DirectionRow): boolean {
    // Global directions stay private to Firstmate. Crew receive their
    // project's directions - those saved for any repository in it (INF-4220)
    // - including when a brief is carried to another computer.
    if (actor.kind === "firstmate") return true;
    const projects = this.handle.deps.projects;
    if (row.scope === PRIVATE_SCOPE || !projects.get(row.scope) || !projects.get(actor.repoId))
      return false;
    return (
      row.scope === actor.repoId || Boolean(projects.together?.(actor.repoId).includes(row.scope))
    );
  }

  /** The captain's scope, or a project still registered; a removed one's directions stay out. */
  private known(scope: string): boolean {
    return scope === PRIVATE_SCOPE || Boolean(this.handle.deps.projects.get(scope));
  }

  private scope(scope: string): string {
    if (!this.known(scope)) refuse("This project is not available.");
    return scope;
  }

  private row(row: DirectionRow): KnowledgeDirectionRow {
    return {
      id: row.id,
      kind: "direction",
      text: row.text,
      scope: row.scope,
      scopeName:
        row.scope === PRIVATE_SCOPE
          ? CAPTAIN_SCOPE_NAME
          : (this.handle.deps.projects.get(row.scope)?.name ?? row.scope),
      origin: row.origin,
      authority: row.origin === "captain-turn" ? "instruction" : "advice",
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  }
}

/** Standing directions travel whole, independently of a topical lookup. */
export function renderDirections(rows: readonly KnowledgeDirectionRow[]): string | undefined {
  return [
    "Standing directions. Captain-origin records are instructions; other origins are advice. No record grants permission beyond its task, and a captain-origin direction that a step needs no consent is that consent. These are the current directions; they supersede earlier copies in this conversation.",
    ...(rows.length ? [] : ["No current standing directions."]),
    ...rows.map((row) =>
      JSON.stringify({
        id: `d:${row.id}`,
        scope: row.scope,
        project: row.scopeName,
        origin: row.origin,
        authority: row.authority,
        text: row.text,
      }),
    ),
  ].join("\n");
}

/** A deliberate tool read, including the direction's own history. */
export function renderDirection(direction: KnowledgeDirection): string {
  return JSON.stringify({ ...direction, id: `d:${direction.id}` }, null, 2);
}
