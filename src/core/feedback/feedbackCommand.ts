import {
  FEEDBACK_KINDS,
  type FeedbackKind,
  GITHUB_ISSUE_BODY_MAX,
  GITHUB_ISSUE_TITLE_MAX,
} from "@shared/feedback";
import type { FeedbackAskFacts } from "@shared/writeAsk";
import {
  diagnosticsLines,
  type FeedbackDiagnostics,
  fittedBody,
  newIssueLink,
} from "./diagnostics";
import { guardMatches, guardRefusal, type HeldIdentifier } from "./guard";

/**
 * What `infinitary-feedback-axi` reaches for one task (docs/feedback.md;
 * docs/axi-commands.md, "The feedback command"): the diagnostics it would
 * carry, the project's similar issues, and a draft kept for the captain's
 * click. Every decision is the host's: the destination is the build's own
 * public project, the guard runs before anything is kept, and a kept draft
 * is sent only by the click on the crewmate's card.
 */

export type FeedbackAnswer = {
  text?: string;
  data?: Record<string, unknown>;
  refused?: "invalid" | "refused";
};

export type TaskFeedback = {
  diagnostics(input: { task?: string }): Promise<FeedbackAnswer>;
  similar(input: { words: string }): Promise<FeedbackAnswer>;
  draft(input: {
    kind: string;
    title: string;
    body: string;
    commentOn?: number;
    /** The task the report is about, whose facts the diagnostics carry. */
    task?: string;
  }): Promise<FeedbackAnswer>;
};

/** One issue a search found, as the command lists it. */
export type SimilarIssue = {
  number: number;
  title: string;
  state: string;
  comments: number;
  reactions: number;
};

/** What the host supplies the command, each a typed reading or the one effect, keeping a write. */
export type FeedbackHost = {
  /** The build's own public project, `owner/name`. */
  repository: string;
  /** The facts the report carries, with a named task's when it is one the host knows. */
  diagnostics: (taskKey?: string) => FeedbackDiagnostics | { unknownTask: string };
  /** Every identifier the host holds about the person, read when a draft is checked. */
  held: () => Promise<HeldIdentifier[]>;
  /** Whether the app has a github.com sign-in to keep a write for. */
  signedIn: () => boolean;
  /** The project's issues matching a search, through the sign-in or GitHub's public search. */
  searchIssues: (taskId: string, query: string) => Promise<SimilarIssue[]>;
  /** Keep the issue or comment for the captain's click; answers the ask's id. */
  keep: (
    taskId: string,
    write: { path: string; body: string; feedback: FeedbackAskFacts },
  ) => string;
};

// i18n-exempt: the feedback command's answers are read by a crewmate, in English
const SAY = {
  unknownTask: (key: string) => `No task ${key} is on the record. Name a task by its key.`,
  noWords: "Give a few words describing the problem.",
  searchFailed: (why: string) => `The search did not answer: ${why}`,
  kind: "Give --kind bug or --kind idea.",
  noTitle: "Give the issue a title with --title.",
  longTitle: `A title is at most ${GITHUB_ISSUE_TITLE_MAX} characters.`,
  emptyBody: "The body file is empty.",
  longBody: `The body is too long for an issue: GitHub takes at most ${GITHUB_ISSUE_BODY_MAX} characters with the diagnostics. Shorten it.`,
  commentOn: "Name the issue to comment on by its number.",
  linkNote:
    "No GitHub sign-in: show this link on your card as Open the filled-in issue on GitHub, with the exact title and body, and the actions I published it and Not now.",
  keptNote: (ask: string) =>
    `Kept for the captain's click. Emit your card with one action whose effect is {"kind":"request_write","ask":"${ask}"} and no label, beside your own Not now; the app draws the exact text. Only the captain's click sends it, once.`,
};

function invalid(text: string): FeedbackAnswer {
  return { text, refused: "invalid" };
}

export function taskFeedback(host: FeedbackHost, taskId: string): TaskFeedback {
  const facts = (taskKey?: string) => host.diagnostics(taskKey);
  return {
    diagnostics: async ({ task }) => {
      const read = facts(task?.trim() || undefined);
      if ("unknownTask" in read) return invalid(SAY.unknownTask(read.unknownTask));
      return { data: { diagnostics: diagnosticsLines(read).map((line) => line.slice(2)) } };
    },
    similar: async ({ words }) => {
      const query = words.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!query) return invalid(SAY.noWords);
      try {
        const found = await host.searchIssues(taskId, `repo:${host.repository} is:issue ${query}`);
        return { data: { issues: found } };
      } catch (caught) {
        return {
          text: SAY.searchFailed(caught instanceof Error ? caught.message : String(caught)),
          refused: "refused",
        };
      }
    },
    draft: async (input) => {
      const kind = input.kind.trim() as FeedbackKind;
      if (!FEEDBACK_KINDS.includes(kind)) return invalid(SAY.kind);
      const title = input.title.replace(/\s+/g, " ").trim();
      if (!title) return invalid(SAY.noTitle);
      if (title.length > GITHUB_ISSUE_TITLE_MAX) return invalid(SAY.longTitle);
      const words = input.body.trim();
      if (!words) return invalid(SAY.emptyBody);
      const commentOn = input.commentOn;
      if (commentOn !== undefined && (!Number.isSafeInteger(commentOn) || commentOn < 1))
        return invalid(SAY.commentOn);
      const matches = guardMatches(`${title}\n${words}`, await host.held());
      if (matches.length > 0) return { text: guardRefusal(matches), refused: "refused" };
      const report = facts(input.task?.trim() || undefined);
      if ("unknownTask" in report) return invalid(SAY.unknownTask(report.unknownTask));
      const body = fittedBody(words, report, kind, GITHUB_ISSUE_BODY_MAX);
      if (body === undefined) return invalid(SAY.longBody);
      if (!host.signedIn()) {
        const link = newIssueLink(host.repository, title, words, report, kind);
        return {
          data: {
            link,
            title,
            body,
            note: SAY.linkNote,
          },
        };
      }
      const ask = host.keep(taskId, {
        path:
          commentOn !== undefined
            ? `/repos/${host.repository}/issues/${commentOn}/comments`
            : `/repos/${host.repository}/issues`,
        body: JSON.stringify(commentOn !== undefined ? { body } : { title, body }),
        feedback: {
          kind,
          title,
          ...(commentOn !== undefined ? { commentOn } : {}),
        },
      });
      return {
        data: {
          ask,
          ...(commentOn !== undefined ? { commentOn } : {}),
          title,
          note: SAY.keptNote(ask),
        },
      };
    },
  };
}
