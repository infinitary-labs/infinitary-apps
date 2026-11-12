import { workRequests } from "@shared/work";
import type { BoundTool, ToolOutput } from "./tools";

/**
 * The work request each of the app's own crewmate tools sends its home
 * from a computer that runs work: the one place a tool's effect is read
 * from (`workRequests`, src/shared/work.ts), on this Mac as there. A tool
 * missing here is never the app's own: a shell command, a web fetch, a
 * helper agent or another tool server's tool.
 */
export const APP_TOOL_REQUESTS = {
  emit_card: "inf:work:card",
  close_card: "inf:work:close-card",
  file_followup: "inf:work:followup",
  start_program: "inf:work:start-program",
  note_progress: "inf:work:progress",
  report: "inf:work:report",
  reply: "inf:work:reply",
  revise_required_action: "inf:work:revise-required-action",
  tasks: "inf:work:tasks",
  read_workflow: "inf:work:read-workflow",
  github_read: "inf:work:github-read",
  github_write: "inf:work:github-write",
  prepare_change: "inf:work:prepare-change",
  open_change: "inf:work:open-change",
  show_merge_card: "inf:work:show-merge-card",
  check_change: "inf:work:check-change",
  download_artifact: "inf:work:download-artifact",
  knowledge: "inf:work:knowledge",
  record_knowledge: "inf:work:record-knowledge",
} as const satisfies Record<string, keyof typeof workRequests>;

/** Whether a tool is the app's own and declared a read: one the app may answer for (INF-2603). */
export function isAppRead(toolName: string): boolean {
  const channel = APP_TOOL_REQUESTS[toolName as keyof typeof APP_TOOL_REQUESTS];
  return channel !== undefined && workRequests[channel].effect === "read";
}

/** One read the app answered for, by its tool and when it began. */
export type AnsweredRead = { tool: string; since: number };

/** The answer a read the app gave up on gets: it changed nothing, so asking again is safe. */
export function answeredReadText(tool: string, waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000));
  return `Infinitary answered this ${tool} call for you: it had no answer after ${minutes} minute${minutes === 1 ? "" : "s"}, so it may have been lost on the way. It is a read, so nothing was changed. Ask for it again if you still need it.`;
}

type Open = {
  tool: string;
  since: number;
  mark: number;
  answer: (waitedMs: number) => void;
};

/**
 * The app's own reads a conversation has open, on the computer that runs
 * it (INF-2603). A read the quiet watchdog finds still open after its
 * quiet stretch is answered "ask again" here, so the turn goes on and
 * reads any steer queued behind it. Only a declared read is ever answered
 * this way: a change the app was making, and every call the crewmate
 * started itself, run on until they return.
 *
 * Each read is marked when it begins: on this Mac with the time, and on a
 * computer that runs work with the number of the conversation's newest
 * event, so the home's ask names reads by the events it has seen and the
 * two computers' clocks never decide which read is answered.
 */
export class OpenReads {
  private readonly open = new Set<Open>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly mark: () => number = now,
  ) {}

  /** The tools as the conversation serves them: each app read answerable here. */
  serve(tools: readonly BoundTool[]): BoundTool[] {
    return tools.map((tool) =>
      isAppRead(tool.name)
        ? { ...tool, run: (params, signal) => this.run(tool, params, signal) }
        : tool,
    );
  }

  /**
   * Answers "ask again" every read marked at or before `upTo`, and cancels
   * the work behind it when the conversation gave the call a cancellation.
   */
  answer(upTo: number): AnsweredRead[] {
    const now = this.now();
    const answered: AnsweredRead[] = [];
    for (const open of [...this.open]) {
      if (open.mark > upTo) continue;
      this.open.delete(open);
      answered.push({ tool: open.tool, since: open.since });
      open.answer(Math.max(0, now - open.since));
    }
    return answered;
  }

  private run(tool: BoundTool, params: unknown, signal?: AbortSignal): Promise<ToolOutput> {
    const stop = new AbortController();
    // A call with no cancellation keeps the arguments its host expects.
    const linked = signal ? AbortSignal.any([signal, stop.signal]) : undefined;
    return new Promise<ToolOutput>((resolve, reject) => {
      const open: Open = {
        tool: tool.name,
        since: this.now(),
        mark: this.mark(),
        answer: (waitedMs) => {
          stop.abort();
          reject(new Error(answeredReadText(tool.name, waitedMs)));
        },
      };
      this.open.add(open);
      tool
        .run(params, linked)
        .then(resolve, reject)
        .finally(() => this.open.delete(open));
    });
  }
}
