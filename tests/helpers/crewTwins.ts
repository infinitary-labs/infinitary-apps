import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionRecordStore } from "../../src/core/storage/sessionRecordStore.ts";

/**
 * One crewmate's recorded work, written twice: as a Pi crewmate's session
 * file and as a Claude crewmate's record - the app's copy of the client's
 * transcript beside its served sidecar - both where the app keeps them,
 * `crewmates/<task>/sessions/`. The same turns in each backend's own
 * dialect, so a reader that reads both through the one session reader
 * yields the same work from either.
 */

type CrewTurn = {
  brief: string;
  /** The captain's words folded into the running turn after its tool ran. */
  steer?: string;
  tool: { name: string; args: Record<string, unknown>; result: string };
  closing: string;
};

export const CREW_TWIN_TURNS: readonly CrewTurn[] = [
  {
    brief: "Fix the flaky sign-in test. It fails about one run in five.",
    steer: "Also check the settings page while you are there.",
    tool: {
      name: "note_progress",
      args: { note: "Reproduced the flake on the third run." },
      result: "Noted.",
    },
    closing: "The flake is a race in the session cookie; fixing it next.",
  },
  {
    brief: "The fix is in. Report back.",
    tool: {
      name: "report",
      args: { summary: "The sign-in test passes on every run." },
      result: "Reported.",
    },
    closing: "Done: the sign-in test passes on every run.",
  },
];

/** The time of one step of one turn: turn n at minute n. */
export function crewTwinTime(turn: number, step: number): string {
  return new Date(Date.UTC(2026, 8, 27, 10, turn, step)).toISOString();
}

export function crewSessionsDir(root: string, taskId: string): string {
  const dir = join(root, "crewmates", taskId, "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function piCrewTwin(dir: string): string {
  const lines: unknown[] = [
    { type: "session", version: 3, id: "pi-crew", timestamp: crewTwinTime(0, 0), cwd: "/wt" },
  ];
  CREW_TWIN_TURNS.forEach((turn, n) => {
    const message = (step: number, body: Record<string, unknown>) => ({
      type: "message",
      id: `m${n}-${step}`,
      timestamp: crewTwinTime(n, step),
      message: body,
    });
    lines.push(message(1, { role: "user", content: [{ type: "text", text: turn.brief }] }));
    lines.push(
      message(2, {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5",
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: `call-${n}`, name: turn.tool.name, arguments: turn.tool.args },
        ],
      }),
    );
    lines.push(
      message(3, {
        role: "toolResult",
        toolCallId: `call-${n}`,
        toolName: turn.tool.name,
        content: [{ type: "text", text: turn.tool.result }],
        isError: false,
      }),
    );
    if (turn.steer) {
      lines.push(message(4, { role: "user", content: [{ type: "text", text: turn.steer }] }));
    }
    lines.push(
      message(5, {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5",
        stopReason: "stop",
        content: [{ type: "text", text: turn.closing }],
      }),
    );
  });
  const path = join(dir, "2026-09-27T10-00-00-000Z_pi-crew.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

/** The Claude crewmate's record: the client's transcript as the app copied it, and its sidecar. */
export function claudeCrewTwin(dir: string): string {
  const sessionId = "c1a0de00-0000-4000-8000-00000000c0de";
  const store = new SessionRecordStore(dir);
  const line = (body: Record<string, unknown>) => ({
    sessionId,
    isSidechain: false,
    userType: "external",
    cwd: "/wt",
    version: "2.1.234",
    ...body,
  });
  const lines: unknown[] = [];
  // A crewmate's role stamps no contract: its sidecar holds served stamps alone.
  const served: unknown[] = [];
  CREW_TWIN_TURNS.forEach((turn, n) => {
    const uuid = (step: number) => `u${n}-${step}`;
    lines.push(
      line({
        type: "user",
        uuid: uuid(1),
        timestamp: crewTwinTime(n, 1),
        message: { role: "user", content: turn.brief },
      }),
    );
    lines.push(
      line({
        type: "assistant",
        uuid: uuid(2),
        timestamp: crewTwinTime(n, 2),
        message: {
          id: `msg-${n}-a`,
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `call-${n}`,
              name: `mcp__infinitary__${turn.tool.name}`,
              input: turn.tool.args,
            },
          ],
        },
      }),
    );
    lines.push(
      line({
        type: "user",
        uuid: uuid(3),
        timestamp: crewTwinTime(n, 3),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `call-${n}`,
              content: [{ type: "text", text: turn.tool.result }],
            },
          ],
        },
      }),
    );
    if (turn.steer) {
      lines.push(
        line({
          type: "attachment",
          uuid: uuid(4),
          timestamp: crewTwinTime(n, 4),
          attachment: { type: "queued_command", prompt: turn.steer, source_uuid: `steer-${n}` },
        }),
      );
    }
    lines.push(
      line({
        type: "assistant",
        uuid: uuid(5),
        timestamp: crewTwinTime(n, 5),
        message: {
          id: `msg-${n}-b`,
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: turn.closing }],
        },
      }),
    );
    served.push({
      kind: "served",
      at: Date.parse(crewTwinTime(n, 6)),
      prompt: { textSha256: "", uuid: uuid(1) },
      steers: turn.steer ? [{ textSha256: "", uuid: `steer-${n}` }] : [],
    });
  });
  const path = store.transcriptPath(sessionId);
  writeFileSync(path, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  writeFileSync(
    store.sidecarPath(sessionId),
    `${served.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return path;
}
