import type { PushPayload } from "@shared/ipc";
import type { TaskBoard } from "@shared/tasks";

/**
 * What the browser project's Node side gives its pages (docs/testing.md,
 * "The browser layer"): the fresh home's answers and the stories its core
 * played, provided by its global setup (./browserFreshHome.ts), and the
 * commands a page may ask of itself (./browserCommands.ts). Both sides read
 * these types.
 */

/**
 * Each core read channel's answer, as a fresh home gives it: `plain` for
 * reads that take no arguments, `asked` for the reads with arguments the
 * setup names, by channel and then by the request as JSON.
 */
export type FreshHomeAnswers = {
  plain: Record<string, unknown>;
  asked: Record<string, Record<string, unknown>>;
};

/** One push main forwards to the window, as the core emitted it. */
export type StoryPush =
  | { channel: "inf:event"; payload: PushPayload<"inf:event"> }
  | { channel: "inf:tasks"; payload: PushPayload<"inf:tasks"> }
  | { channel: "inf:tasks:delta"; payload: PushPayload<"inf:tasks:delta"> };

/**
 * A crewmate sent out and then cancelled, as the fresh home's core played it
 * (./browserFreshHome.ts): each board the window reads on the way, and the
 * pushes between them in the order the core sent them.
 */
export type CrewStory = {
  /** The fresh home's board, with no crew. */
  fresh: TaskBoard;
  /** Sent as one crewmate goes out and goes idle. */
  arrive: StoryPush[];
  /** The board with that idle crewmate. */
  crewed: TaskBoard;
  /** Sent as it is cancelled. */
  cancel: StoryPush[];
  /** The board after, its task dropped. */
  dropped: TaskBoard;
};

/** The media a person's system sets for motion. */
export type ReducedMotion = "reduce" | "no-preference";

declare module "vitest" {
  interface ProvidedContext {
    freshHome: FreshHomeAnswers;
    crewStory: CrewStory;
  }
}

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateReducedMotion(reducedMotion: ReducedMotion): Promise<void>;
    evaluateInFrame(name: string, source: string, argument?: unknown): Promise<unknown>;
    clearCookies(): Promise<void>;
  }
}
