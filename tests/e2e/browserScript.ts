import { parseServedInput } from "@shared/servedFrame";
import { BROWSER_COMMAND } from "../../src/core/browser/commandWords";
import { REF_PATTERN } from "../../src/core/browser/outline";
import { renderWake } from "../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../src/core/pi/bashWords";
import type { ScriptedCall } from "../helpers/scriptedCalls";
import { providerMessages } from "./providerRequest";

/**
 * A scripted crewmate's browser commands and how it reads their answers
 * (docs/axi-commands.md): the command it runs in its shell, the browser's
 * answer in the browser's own words, a command that ran past the shell's
 * limit read again with the next look, and the refs an outline names.
 */

/** The choice beside a scripted browser request that leaves its task waiting. */
export const MOCK_LEAVE_WAITING = "Leave waiting";

/**
 * A crewmate's browser command, as it runs it in its shell
 * (docs/axi-commands.md): `infinitary-browser-axi` and its arguments, each one
 * shell word. Pi serves the shell as `bash` and Claude's client as `Bash`
 * (`servedToolName`), so one script drives both.
 */
export function browser(...args: (string | number)[]): ScriptedCall {
  const words = args.map((arg) => {
    const word = String(arg);
    return /^[A-Za-z0-9@:._/=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  });
  return {
    name: "bash",
    args: {
      command: [BROWSER_COMMAND, ...words].join(" "),
      description: "Use this task's browser",
    },
  };
}

/** Whether a tool answer is a browser command's: what infinitary-browser-axi printed. */
function isBrowserAnswer(text: string): boolean {
  return /^(?:page:|browser:|running:|earlier:|error:|pages\[|bin: )/m.test(shellOutput(text));
}

/** What a shell command printed, after the exit line Pi's shell (or Claude's on a failure) puts first. */
function shellOutput(text: string): string {
  return text.replace(/^(?:Error: )?(?:exit|Exit code) \d+\n/, "");
}

/**
 * A browser command's answer as the scripts read it, in the browser's own
 * words: an error is its message, and a quoted fact line reads unquoted, so
 * `did: Clicked button "Send" [g1:e3].` reads as the browser wrote it.
 */
function browserWords(text: string): string {
  const printed = shellOutput(text);
  const error = printed.match(/^error: (.*)$/m)?.[1];
  const unquote = (value: string): string => {
    try {
      return value.startsWith('"') ? (JSON.parse(value) as string) : value;
    } catch {
      return value;
    }
  };
  if (error !== undefined) return unquote(error);
  return printed
    .split("\n")
    .map((line) => {
      const fact = /^(\s*(?:did|title|url|browser|earlier): )(".*")$/.exec(line);
      return fact ? `${fact[1]}${unquote(fact[2] as string)}` : line;
    })
    .join("\n");
}

/** A command that ran past the shell's limit said so; its answer comes with the next look. */
function stillRunning(text: string): boolean {
  const printed = shellOutput(text);
  return /^running: /m.test(printed) || /^code: BUSY$/m.test(printed);
}

/**
 * INF-634: the shell may legitimately become a job before the launcher
 * reaches the app, or after its bounded grace. Its receipt is not browser
 * output. Resume from that job's exit wake, never by sending the action again.
 * Keep message positions so handoff scripts can still slice at their wake.
 */
export function browserShellMessages(messages: ReturnType<typeof providerMessages>) {
  const pending = new Set<string>();
  const readings = messages.map((message) => {
    const job =
      message.role === "tool" ? /^Still running as background job (\S+);/.exec(message.text) : null;
    if (job) {
      pending.add(job[1] as string);
      return { role: "assistant" as const, text: "" };
    }
    if (message.role !== "user") return message;
    const wakes = parseServedInput(message.text)
      ?.filter((part) => part.kind === "wake")
      .map((part) => part.body) ?? [message.text];
    for (const wake of wakes) {
      const exit = /^\[job\] background job (\S+) finished:/.exec(wake);
      if (!exit || !pending.delete(exit[1] as string)) continue;
      const output = wake.indexOf(". Output tail:\n");
      return {
        role: "tool" as const,
        text: output < 0 ? wake : wake.slice(output + ". Output tail:\n".length),
      };
    }
    return message;
  });
  return { readings, pending: pending.size > 0 };
}

/** Stands for the part of a composer's words a reader looks for around them. */
const HOLE = "\u0000";

/** The job a bash answer says is still running, read in the bash tool's own words; none when it finished. */
function receiptJob(answer: string): string | undefined {
  const [before, after] = backgroundJobReceipt(HOLE).split(HOLE) as [string, string];
  const end = answer.startsWith(before) ? answer.indexOf(after, before.length) : -1;
  return end < 0 ? undefined : answer.slice(before.length, end);
}

/** Whether `wake` is job `id`'s exit, read in the wake renderer's own words. */
function exitOf(wake: string, id: string): boolean {
  const exit = renderWake({
    facts: {
      kind: "job-exit",
      to: "crewmate",
      jobId: id,
      command: HOLE,
      exitCode: 0,
      durationMs: 0,
    },
  });
  return wake.startsWith(exit.slice(0, exit.indexOf(HOLE)));
}

/**
 * Whether a shell command of this conversation is still running as a
 * background job: its receipt came back and no exit wake has followed yet,
 * across every message, so several jobs may end in one wake turn. A file a
 * stand-in wrote that way is not written until its job has exited (INF-1128).
 */
export function shellJobsRunning(body: string): boolean {
  const running = new Set<string>();
  for (const message of providerMessages(body)) {
    const job = message.role === "tool" ? receiptJob(message.text) : undefined;
    if (job) running.add(job);
    if (message.role !== "user") continue;
    const wakes = parseServedInput(message.text)
      ?.filter((part) => part.kind === "wake")
      .map((part) => part.body) ?? [message.text];
    for (const id of running) if (wakes.some((wake) => exitOf(wake, id))) running.delete(id);
  }
  return running.size > 0;
}

/**
 * The tool answers after a place in the conversation, oldest first, each
 * browser command once in the browser's own words: one that ran past a
 * Pi shell's limit answered `running`, and its answer came with the next
 * look (`earlier`), so the two read as the one answer the browser gave.
 */
export function toolAnswers(messages: ReturnType<typeof providerMessages>, from = 0): string[] {
  const answers: string[] = [];
  let waiting = false;
  for (const message of browserShellMessages(messages).readings.slice(from)) {
    if (message.role !== "tool") continue;
    if (!isBrowserAnswer(message.text)) {
      answers.push(message.text);
      continue;
    }
    if (stillRunning(message.text)) {
      waiting = true;
      continue;
    }
    const words = browserWords(message.text);
    if (waiting) {
      waiting = false;
      answers.push(
        words
          .replace(/^earlier: .*\n/m, "")
          .replace(
            /^Your earlier \S+ finished(?:, so this \S+ was not run; run it again if you still need it)?: /,
            "",
          ),
      );
      continue;
    }
    answers.push(words);
  }
  return answers;
}

/** The first sentence of an answer, as a report quotes it. */
export function firstSentence(text: string | undefined): string {
  const passage =
    (text ?? "").split("\n").find((line) => line.startsWith("The captain returned control")) ??
    (text ?? "").match(/^did: (.*)$/m)?.[1] ??
    text;
  return (passage ?? "").split("\n")[0]?.split(/(?<=[.:])\s/)[0] ?? "";
}

/**
 * The ref an outline gave a control, by its role and the start of its name;
 * `text` with no name finds the first cut passage, the one text line a ref names.
 */
export function refOf(outline: string | undefined, role: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return outline?.match(new RegExp(`${role} "${escaped}[^"]*" \\[(${REF_PATTERN})\\]`))?.[1];
}

/** A same-page action need not repeat unchanged controls. Keep refs only in the current book. */
export function knownRefOf(
  answers: readonly string[],
  role: string,
  name: string,
): string | undefined {
  const book = [...answers]
    .reverse()
    .map((text) => text.match(/^\s*refs: (g\d+)$/m)?.[1])
    .find(Boolean);
  for (const answer of [...answers].reverse()) {
    const current = answer
      .split("\n")
      .filter((line) => !line.startsWith("- old line "))
      .join("\n");
    const ref = refOf(current, role, name);
    if (ref && (!book || ref.startsWith(`${book}:`))) return ref;
  }
  return undefined;
}

/**
 * A browser journey's next step, looking again first while the crewmate's
 * last command still runs in its browser: a command past a Pi shell's
 * limit keeps running, and the bare command reads its answer.
 */
export function lookingAgain(
  body: string,
  step: (body: string) => ScriptedCall[] | undefined,
): ScriptedCall[] | undefined {
  const { readings, pending } = browserShellMessages(providerMessages(body));
  if (pending) return undefined;
  const last = readings.at(-1);
  if (last?.role === "tool" && isBrowserAnswer(last.text) && stillRunning(last.text)) {
    return [browser()];
  }
  return step(body);
}
