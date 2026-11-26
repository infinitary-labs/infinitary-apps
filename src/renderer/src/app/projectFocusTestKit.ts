import type { ProjectView, TaskBoard } from "@shared/tasks";

/**
 * The task board as the window's project focus reads it (`./projectFocus`),
 * for a test that needs the real focus rule: the stand-in for the app's
 * read executor hands each `tasks.board` reader the board `showBoard` sets.
 * Mock the executor with `vi.mock("../plugins/reads/appExecutor", () =>
 * import("./projectFocusTestKit").then((kit) => kit.appExecutorStandIn()))`.
 */
const readers = new Set<(board: TaskBoard) => void>();
let shown: TaskBoard | null = null;

export function appExecutorStandIn() {
  return {
    appReadExecutor: () => ({
      subscribe(name: string, _args: unknown, listener: { onValue: (value: unknown) => void }) {
        if (name !== "tasks.board") return () => {};
        const reader = (board: TaskBoard) => listener.onValue(board);
        readers.add(reader);
        if (shown) reader(shown);
        return () => readers.delete(reader);
      },
    }),
  };
}

/** A project set up in Settings with one repository, as the board lists it. */
export function project(id: string, key: string, name: string): ProjectView {
  return {
    id,
    key,
    name,
    repo: { id: `repo-${id}`, name, delivery: "direct-pr", autonomy: false, kind: "project" },
    archived: false,
    counts: { needsYou: 0, waitingOnYou: 0, open: 0, active: 0, doneRecent: 0 },
  };
}

/** The board every focus reader sees from now on. */
export function showBoard(projects: ProjectView[]): void {
  shown = { seq: 1, at: 1_000, projects, tasks: [], links: [] };
  for (const reader of readers) reader(shown);
}
