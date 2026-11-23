import { FEEDBACK_COMMAND } from "@shared/feedback";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import type { FeedbackAnswer } from "../feedback/feedbackCommand";
import type { AxiArguments, TaskAxiCli } from "./cli";
import type { ChannelReply } from "./protocol";

/**
 * `infinitary-feedback-axi`, the feedback command (docs/axi-commands.md,
 * "The feedback command"; docs/feedback.md): a crewmate drafting a /feedback
 * report reads the diagnostics the issue carries, looks for similar issues
 * on Infinitary's own public project and keeps its draft for the captain's
 * click. It never sends anything itself.
 */

export type FeedbackOp = "feedback.diagnostics" | "feedback.similar" | "feedback.draft";

export type FeedbackOpInput = {
  "feedback.diagnostics": { task?: string };
  "feedback.similar": { words: string };
  "feedback.draft": {
    kind: string;
    title: string;
    bodyFile: string;
    commentOn?: number;
    task?: string;
  };
};

export type FeedbackReply = ChannelReply<FeedbackAnswer>;

export type FeedbackConnection = {
  call: <Op extends FeedbackOp>(
    command: string,
    op: Op,
    input: FeedbackOpInput[Op],
  ) => Promise<FeedbackReply>;
};

// i18n-exempt: the feedback command's answers are read by a crewmate, in English
const DESCRIPTION =
  "A /feedback report for Infinitary's makers: the diagnostics it carries, similar issues on Infinitary's own public project, and a draft kept for the captain's click. Nothing is published before that click.";

// i18n-exempt: the feedback command's answers are read by a crewmate, in English
const HELP = [
  `Run \`${FEEDBACK_COMMAND} diagnostics [--task <key>]\` for the facts a draft carries`,
  `Run \`${FEEDBACK_COMMAND} similar <words>\` before drafting; a close open match makes your draft a comment on it`,
  `Run \`${FEEDBACK_COMMAND} draft --kind bug|idea --title "<title>" --body-file <file> [--comment-on <number>] [--task <key>]\` to keep the draft; the app checks it for personal details and adds the diagnostics`,
  "Read the feedback-report skill for the card that asks the captain",
];

function output(reply: FeedbackReply): string {
  if (reply.kind !== "answer")
    throw new AxiError(
      "The answer did not come back in time. Run the same command again to read it.",
      "BUSY",
    );
  const answer = reply.answer;
  if (answer.refused)
    throw new AxiError(
      answer.text ?? "Refused.",
      answer.refused === "invalid" ? "VALIDATION_ERROR" : "REFUSED",
    );
  const data = answer.data ?? {};
  if (Array.isArray(data.issues) && data.issues.length === 0)
    // i18n-exempt: the feedback command's answers are read by a crewmate, in English
    return `${encode({ issues: "0 similar issues" })}\n${encode({ help: HELP.slice(2) })}\n`;
  return `${encode(data)}\n${encode({ help: HELP })}\n`;
}

const TASK_KEY = /^[A-Za-z0-9_-]{1,64}$/;

function taskFlag(args: AxiArguments): string | undefined {
  const task = args.flags["--task"];
  if (task === undefined) return undefined;
  if (typeof task !== "string" || !TASK_KEY.test(task))
    throw new AxiError("Name the task by its key with --task.", "VALIDATION_ERROR", HELP);
  return task;
}

export function feedbackAxi(
  version: string,
  connect: () => Promise<FeedbackConnection>,
): TaskAxiCli<FeedbackConnection> {
  // i18n-exempt: the feedback command's answers are read by a crewmate, in English
  return {
    name: FEEDBACK_COMMAND,
    description: DESCRIPTION,
    version,
    connect,
    home: async () =>
      `${encode({ command: FEEDBACK_COMMAND, purpose: DESCRIPTION })}\n${encode({ help: HELP })}\n`,
    commands: {
      diagnostics: {
        usage: "diagnostics [--task <key>]",
        description:
          "Print the typed facts a report carries: the app, the system, devices and connections by kind, and a named task's kinds and steps. No names, paths or words.",
        flags: { "--task": "value" },
        run: async (args, connection) => {
          const task = taskFlag(args);
          return output(
            await connection.call("diagnostics", "feedback.diagnostics", task ? { task } : {}),
          );
        },
      },
      similar: {
        usage: "similar <words>",
        description:
          "Search Infinitary's own public project for issues, open and closed, matching the words: number, title, state, comments and reactions.",
        run: async (args, connection) => {
          const words = args.positional.join(" ").trim();
          if (!words)
            throw new AxiError(
              "Give a few words describing the problem.",
              "VALIDATION_ERROR",
              HELP.slice(1, 2),
            );
          return output(await connection.call("similar", "feedback.similar", { words }));
        },
      },
      draft: {
        usage:
          'draft --kind bug|idea --title "<title>" --body-file <file> [--comment-on <number>] [--task <key>]',
        description:
          "Check the draft for personal details the app knows, add the diagnostics and a hidden mark, and keep it for the captain's click: with a GitHub sign-in a write your card asks to send, without one a filled-in link.",
        flags: {
          "--kind": "value",
          "--title": "value",
          "--body-file": "value",
          "--comment-on": "value",
          "--task": "value",
        },
        run: async (args, connection) => {
          const kind = args.flags["--kind"];
          const title = args.flags["--title"];
          const bodyFile = args.flags["--body-file"];
          if (kind !== "bug" && kind !== "idea")
            throw new AxiError(
              "Give --kind bug or --kind idea.",
              "VALIDATION_ERROR",
              HELP.slice(2, 3),
            );
          if (typeof title !== "string" || !title.trim())
            throw new AxiError(
              "Give the issue a title with --title.",
              "VALIDATION_ERROR",
              HELP.slice(2, 3),
            );
          if (typeof bodyFile !== "string" || !bodyFile.trim())
            throw new AxiError(
              "Give the Markdown file holding the body with --body-file.",
              "VALIDATION_ERROR",
              HELP.slice(2, 3),
            );
          const rawComment = args.flags["--comment-on"];
          let commentOn: number | undefined;
          if (rawComment !== undefined) {
            if (typeof rawComment !== "string" || !/^[1-9][0-9]{0,9}$/.test(rawComment))
              throw new AxiError(
                "Name the issue to comment on by its number.",
                "VALIDATION_ERROR",
                HELP.slice(2, 3),
              );
            commentOn = Number(rawComment);
          }
          const task = taskFlag(args);
          return output(
            await connection.call("draft", "feedback.draft", {
              kind,
              title,
              bodyFile,
              ...(commentOn !== undefined ? { commentOn } : {}),
              ...(task ? { task } : {}),
            }),
          );
        },
      },
    },
  };
}
