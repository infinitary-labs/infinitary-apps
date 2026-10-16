import type { FmEvent } from "@shared/events";
import type { ObserveLive } from "@shared/observe";

/**
 * A session's in-flight turn, kept between the event stream and the
 * transcript file (docs/dev-observe.md, "Live vs historical"). The renderer
 * used to accumulate these deltas itself, which meant an Observe pane
 * opened mid-turn saw nothing until the turn ended; holding them here
 * makes the `observe.live` read (src/shared/reads.ts) answer for any
 * session at any moment, and lets a frame that never sees raw events
 * render the stream.
 *
 * Bounded: text keeps its most recent LIVE_TEXT_MAX characters and the
 * tool list its most recent LIVE_TOOLS_MAX entries. A turn's end - clean or
 * failed - clears the buffer, because the file has the turn from then on.
 */
export const LIVE_TEXT_MAX = 65_536;
export const LIVE_TOOLS_MAX = 200;

const EMPTY: Omit<ObserveLive, "id"> = { text: "", tools: [] };

export class ObserveLiveBuffer {
  private readonly sessions = new Map<string, Omit<ObserveLive, "id">>();

  read(sessionId: string): ObserveLive {
    return { id: sessionId, ...(this.sessions.get(sessionId) ?? EMPTY) };
  }

  /** Feeds one broadcast event; events without a session are ignored. */
  apply(event: FmEvent): void {
    switch (event.type) {
      case "assistant_delta": {
        const current = this.sessions.get(event.taskId) ?? EMPTY;
        const text = (current.text + event.text).slice(-LIVE_TEXT_MAX);
        this.sessions.set(event.taskId, { text, tools: current.tools });
        return;
      }
      case "tool_start": {
        const current = this.sessions.get(event.taskId) ?? EMPTY;
        const tools = [...current.tools, { callId: event.callId, toolName: event.toolName }].slice(
          -LIVE_TOOLS_MAX,
        );
        this.sessions.set(event.taskId, { text: current.text, tools });
        return;
      }
      case "tool_end": {
        const current = this.sessions.get(event.taskId);
        if (!current) return;
        this.sessions.set(event.taskId, {
          text: current.text,
          tools: current.tools.map((tool) =>
            tool.callId === event.callId ? { ...tool, isError: event.isError } : tool,
          ),
        });
        return;
      }
      case "turn_end":
      case "turn_failed":
      case "task_finished":
        this.sessions.delete(event.taskId);
        return;
      default:
        return;
    }
  }

  clear(): void {
    this.sessions.clear();
  }
}
