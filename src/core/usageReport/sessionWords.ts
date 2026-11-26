import { statSync } from "node:fs";
import { cutText, cutTextEnd } from "@shared/textCut";
import { defaultClaudeConfigDir } from "../claude/claudeQuota";
import { clientTranscriptAt, seatSessionFiles } from "../claude/claudeTranscript";
import { redactDeep, redactObserveText } from "../observe/redact";
import { type AppPaths, crewmateSessionsDir } from "../paths";
import {
  CLIENT_INTERRUPT_NOTICE,
  CLIENT_NOTICE,
  FILE_TIME_SLACK_MS,
  sessionEntriesBetween,
  sessionFilesIn,
  sessionOffsetAfter,
  timeOf,
} from "../storage/sessionReader";
import { FIRSTMATE_USAGE_TASK_ID } from "../storage/usageStore";
import { crewSessionFiles } from "../tasks/crewTranscript";

type JsonRecord = Record<string, unknown>;

export type WordsPart =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown };

/** One message of a turn, as the conventions' message parts name it. */
export type WordsMessage = {
  role: "user" | "assistant";
  at: number;
  parts: WordsPart[];
  /** The conventions' finish reason, on an assistant's message. */
  finishReason?: string;
};

/** What a turn's session records say was sent and answered, in the order written. */
export type TurnWords = {
  /** Some of it was read from Claude's own client's transcript. */
  claude: boolean;
  messages: WordsMessage[];
};

/**
 * One text part's bound: a turn's prompt often carries a whole served
 * context, and the person's connection sends ten minutes of turns in one
 * request, so a request stays within what a collector takes.
 */
export const WORDS_TEXT_MAX = 8_000;

/** What stands between a long text's two kept ends. */
const CUT_MARK = "\n…\n";

/** One call's arguments' bound as JSON: a file written whole is a call's argument. */
export const WORDS_ARGUMENTS_MAX = 2_000;

/** How many session files keep their place between turns, the least recently read let go first. */
const CURSORS_MAX = 64;

/**
 * A turn's words from Infinitary's own session records (docs/usage-report.md,
 * "Prompts and replies"), for the person's reporting connection when its
 * switch is on: the prompts and steers it was sent, and its replies and tool
 * calls with their arguments, whichever provider served it, read through
 * the one session reader. Never its thinking, its instructions or a tool's
 * result. Keys and tokens the observer's redaction recognizes are hidden
 * before any cut. Each file keeps where the last turn's read stopped, so a
 * long session is read once and then only by what each turn appended.
 */
export class SessionWords {
  private readonly cursors = new Map<string, { ino: number; offset: number; until: number }>();

  /** `filesOf` names the files that may hold a task's lines written after `since`. */
  constructor(private readonly filesOf: (taskId: string, since: number) => readonly string[]) {}

  /** The words the task's sessions wrote after `since` and at or before `until`, or null for none. */
  between(taskId: string, since: number, until: number): TurnWords | null {
    const messages: WordsMessage[] = [];
    let claude = false;
    for (const path of this.filesOf(taskId, since)) {
      let stat: { ino: number; size: number; mtimeMs: number };
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since - FILE_TIME_SLACK_MS) continue;
      const held = this.cursors.get(path);
      // A place is good only for the stretch that starts where it stopped.
      const from =
        held && held.ino === stat.ino && held.offset <= stat.size && held.until === since
          ? held.offset
          : sessionOffsetAfter(path, since);
      const read = sessionEntriesBetween(path, from, since, until);
      this.cursors.delete(path);
      this.cursors.set(path, { ino: stat.ino, offset: read.offset, until });
      if (this.cursors.size > CURSORS_MAX) {
        const oldest = this.cursors.keys().next().value;
        if (oldest !== undefined) this.cursors.delete(oldest);
      }
      const found = wordsOf(read.entries);
      if (found.length > 0 && read.dialect === "claude") claude = true;
      messages.push(...found);
    }
    if (messages.length === 0) return null;
    return { claude, messages: messages.sort((a, b) => a.at - b.at) };
  }
}

/**
 * The app's own records of a task's turns: a crewmate's as its Crewmate tab
 * reads them, and the first mate's from its seat's records, with its Claude
 * seat's own transcript where that holds more.
 */
export function appSessionWords<Task>(
  paths: AppPaths,
  taskOf: (taskId: string) => Task | undefined,
  transcriptOf: (task: Task) => { path: string | null },
): SessionWords {
  return new SessionWords((taskId, since) => {
    if (taskId === FIRSTMATE_USAGE_TASK_ID)
      return [
        ...sessionFilesIn(paths.firstmateSessionsDir),
        ...seatSessionFiles(paths.firstmateClaudeDir, since, (sessionId) =>
          clientTranscriptAt(defaultClaudeConfigDir(), paths.firstmateHomeDir, sessionId),
        ),
      ];
    const task = taskOf(taskId);
    return crewSessionFiles(
      crewmateSessionsDir(paths, taskId),
      task ? transcriptOf(task).path : null,
    );
  });
}

/** The Pi dialect's entries as a turn's messages. */
export function wordsOf(entries: readonly JsonRecord[]): WordsMessage[] {
  const out: WordsMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as JsonRecord | undefined;
    const at = timeOf(entry) ?? (message ? timeOf(message) : null);
    if (!message || at === null) continue;
    if (message.role === "user") {
      // Claude's client queued this notice itself: nobody sent it.
      if (message.commandMode === CLIENT_NOTICE) continue;
      const parts = textsOf(message.content)
        .filter((text) => text.trim() && !CLIENT_INTERRUPT_NOTICE.test(text.trim()))
        .map((text): WordsPart => ({ type: "text", content: wordsText(text) }));
      if (parts.length > 0) out.push({ role: "user", at, parts });
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const parts: WordsPart[] = [];
    for (const part of message.content as unknown[]) {
      if (!part || typeof part !== "object") continue;
      const typed = part as JsonRecord;
      if (typed.type === "text" && typeof typed.text === "string" && typed.text.trim()) {
        parts.push({ type: "text", content: wordsText(typed.text) });
      } else if (typed.type === "toolCall" && typeof typed.name === "string") {
        parts.push({
          type: "tool_call",
          id: typeof typed.id === "string" ? typed.id : "",
          name: typed.name,
          arguments: wordsArguments(typed.arguments),
        });
      }
    }
    if (parts.length > 0)
      out.push({ role: "assistant", at, parts, finishReason: finishReasonOf(message.stopReason) });
  }
  return out;
}

function wordsText(text: string): string {
  // Hidden before the cut: a cut through a key's block would leave a part no pattern knows.
  const hidden = redactObserveText(text);
  if (hidden.length <= WORDS_TEXT_MAX) return hidden;
  // A served prompt puts the app's context first and the words a person typed last: both ends stay.
  const half = Math.floor((WORDS_TEXT_MAX - CUT_MARK.length) / 2);
  return `${cutText(hidden, half)}${CUT_MARK}${cutTextEnd(hidden, half)}`;
}

function wordsArguments(value: unknown): unknown {
  const hidden = redactDeep(value && typeof value === "object" ? value : {});
  const json = JSON.stringify(hidden);
  return json.length > WORDS_ARGUMENTS_MAX ? cutText(json, WORDS_ARGUMENTS_MAX) : hidden;
}

/** The Pi dialect's stop reasons in the conventions' finish reasons; another passes through. */
function finishReasonOf(reason: unknown): string {
  if (reason === "toolUse") return "tool_call";
  if (reason === "aborted") return "error";
  return typeof reason === "string" && reason ? reason : "stop";
}

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part &&
    typeof part === "object" &&
    (part as JsonRecord).type === "text" &&
    typeof (part as JsonRecord).text === "string"
      ? [(part as JsonRecord).text as string]
      : [],
  );
}
