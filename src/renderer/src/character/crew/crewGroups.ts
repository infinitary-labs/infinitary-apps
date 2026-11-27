import type { CrewGrouping } from "@shared/preferences";

/**
 * Grouping the crew animation by project (docs/crew-orbits.md, "Grouping by
 * project"; the captain's answers on INF-6955): which group each crewmate
 * sits in while Settings → Appearance groups the crew by project. Pure, so
 * the desktop's stage and the phone's scene, which replays this rule's own
 * readings (scripts/generate-phone-scene.ts), read one rule.
 *
 * - A crewmate whose computer is away (out of reach, updating, connecting
 *   or removed) stays in that computer's frozen group.
 * - The built-in projects, Scratch and the app's own workspace, always sit
 *   with the first mate.
 * - So does the middle project: the only project of the person's own with
 *   crew, else the focused one, else none.
 * - Every other crewmate sits in its project's group.
 */

/** The first mate's own ring, as the stage names it. */
export const HOME_GROUP = "home";
/** A project group's id is this, then the project's id: never a computer's id. */
export const PROJECT_GROUP = "project:";

export type GroupProject = {
  id: string;
  name: string;
  /** Scratch (no repository) or the app's own workspace (a `personal` repository). */
  builtIn: boolean;
};

export type CrewGroupingInput = {
  grouping: CrewGrouping;
  /** The board's projects, in its order. */
  projects: readonly GroupProject[];
  projectOf: (taskId: string) => string | undefined;
  /** The project the window or phone is focused on; null is All projects. */
  focus: string | null;
};

/** A crewmate on the stage: the computer it runs on, and whether that computer is away. */
export type GroupCrew = { id: string; computer: string; away: boolean };

/** What grouping by project settled for one roster. */
export type GroupPlan = {
  /** The project that orbits the first mate at full size, or none. */
  middle: string | null;
  /** The project groups that hold crew, in the board's order. */
  groups: Array<{ id: string; name: string }>;
};

/** Whether a project from the board is one of the built-in ones. */
export function builtInProject(project: { repo: { kind?: string } | null }): boolean {
  return project.repo === null || project.repo.kind === "personal";
}

/**
 * The plan for this roster, or null for grouping by computer: the switch is
 * off, or the board does not yet name the project of every crewmate whose
 * computer is in reach, as the stage waits for placement.
 */
export function groupPlanOf(
  input: CrewGroupingInput | null,
  crew: readonly GroupCrew[],
): GroupPlan | null {
  if (input?.grouping !== "project") return null;
  const byId = new Map(input.projects.map((project) => [project.id, project]));
  const placed = crew.filter((cm) => !cm.away);
  const own = new Set<string>();
  for (const cm of placed) {
    const project = byId.get(input.projectOf(cm.id) ?? "");
    if (!project) return null;
    if (!project.builtIn) own.add(project.id);
  }
  const focused = input.focus === null ? undefined : byId.get(input.focus);
  const middle =
    own.size === 1 ? ([...own][0] ?? null) : focused && !focused.builtIn ? focused.id : null;
  return {
    middle,
    groups: input.projects
      .filter((project) => own.has(project.id) && project.id !== middle)
      .map((project) => ({ id: PROJECT_GROUP + project.id, name: project.name })),
  };
}

/** The group a crewmate sits in under `plan`; a project the board does not name keeps its computer. */
export function groupOf(plan: GroupPlan, input: CrewGroupingInput, cm: GroupCrew): string {
  if (cm.away) return cm.computer;
  const projectId = input.projectOf(cm.id);
  const project = input.projects.find((p) => p.id === projectId);
  if (!project) return cm.computer;
  return project.builtIn || project.id === plan.middle ? HOME_GROUP : PROJECT_GROUP + project.id;
}
