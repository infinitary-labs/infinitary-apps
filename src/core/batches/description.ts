import type { ForgeKind } from "@shared/forge";
import { BATCH_STORIES_MARKER, presentationMarkdownText } from "../forge";

/**
 * The most characters a host keeps in a pull request's description and in
 * one comment on it (`presentationBodyLimit`, `presentationCommentLimit`).
 * A comment limit of 0 is a host the app writes no comments on.
 */
export type BatchLimits = { description: number; comment: number };

/** A change of the batch, in its order, with its story when it could be written. */
export type BatchEntry = { title: string; region?: string; issue?: string };

/** The outside issue a change answers (`WorkShape.issue`): closed by a fix or a plan's last piece. */
export type ChangeIssue = { number: number; closes?: boolean };

/**
 * The words that link a published change to the outside issue it answers
 * (docs/forge.md, "A change that answers an issue"): Closes #N for a change
 * that closes it, Part of #N for any other, on a host whose issues read
 * them - GitHub, the one host a reader's Build row files from.
 */
export function issueLine(issue: ChangeIssue | undefined, kind: ForgeKind): string | undefined {
  if (!issue || kind !== "github") return undefined;
  return issue.closes ? `Closes #${issue.number}` : `Part of #${issue.number}`;
}

export type BatchDescription = {
  body: string;
  /** The app's own comments that carry the stories the description cannot hold, in order. */
  comments: string[];
  /** The changes, by their place in the batch, whose story neither the description nor a comment can hold. */
  unplaced: number[];
};

/** The words a batch of several writes around its stories where the project lives, from one owner. */
export const BATCH_DESCRIPTION_WORDS = {
  opening: (changes: number) =>
    `This pull request carries ${changes} approved changes as one batch. Each merges as its own commit, in this order:`,
  continued: (stories: number) =>
    stories === 1
      ? "The story of one of these changes did not fit in this description, so it follows in a comment below."
      : `The stories of ${stories} of these changes did not fit in this description, so they follow in order in comments below.`,
  part: (part: number, parts: number) =>
    parts === 1
      ? "Stories of this batch's changes that did not fit in its description."
      : `Stories of this batch's changes that did not fit in its description, part ${part} of ${parts}.`,
} as const;

/** A batch's changes as a list, in order: in its description and in its squash commit's message. */
export const batchList = (entries: readonly Pick<BatchEntry, "title" | "issue">[]) =>
  entries.map((entry) => `- ${entry.title}${entry.issue ? ` (${entry.issue})` : ""}`).join("\n");

/** Characters as the hosts count them: by code point. */
const length = (text: string) => Array.from(text).length;
const SEPARATOR = "\n\n";

/**
 * A batch of several's description as the host can hold it (docs/forge.md,
 * "Batches of your own"): the changes listed in order, then each one's story
 * under its title. When the stories pass the host's description limit, the
 * description keeps the list and the stories that fit, in order, and says
 * how many follow; the rest follow in order in comments, each within the
 * host's comment limit. A story too long for a comment of its own is
 * unplaced, never cut.
 */
export function batchDescription(
  entries: readonly BatchEntry[],
  limits: BatchLimits,
): BatchDescription {
  const head = [BATCH_DESCRIPTION_WORDS.opening(entries.length), batchList(entries)];
  const stories = entries.flatMap((entry, index) =>
    entry.region === undefined
      ? []
      : [{ index, text: `# ${presentationMarkdownText(entry.title)}${SEPARATOR}${entry.region}` }],
  );
  const whole = [...head, ...stories.map((story) => story.text)].join(SEPARATOR);
  if (length(whole) <= limits.description) return { body: whole, comments: [], unplaced: [] };

  // The description keeps the stories that fit in order, at least one story fewer than all,
  // with room for the sentence saying how many follow, sized as if every remaining one does.
  const before = length(head.join(SEPARATOR)) + length(SEPARATOR);
  let shown = 0;
  let kept = 0;
  while (shown < stories.length - 1) {
    const adding = length(SEPARATOR) + length((stories[shown] as (typeof stories)[number]).text);
    const following = BATCH_DESCRIPTION_WORDS.continued(stories.length - shown - 1);
    if (before + length(following) + kept + adding > limits.description) break;
    kept += adding;
    shown += 1;
  }
  const rest = stories.slice(shown);

  // Each comment opens with the marker and the part it is; sized at the most parts there can be.
  const opening = length(
    [BATCH_STORIES_MARKER, BATCH_DESCRIPTION_WORDS.part(rest.length, rest.length)].join(SEPARATOR),
  );
  const parts: { texts: string[]; size: number }[] = [];
  const unplaced: number[] = [];
  for (const story of rest) {
    const own = length(SEPARATOR) + length(story.text);
    if (opening + own > limits.comment) {
      unplaced.push(story.index);
      continue;
    }
    const last = parts.at(-1);
    if (last && last.size + own <= limits.comment) {
      last.texts.push(story.text);
      last.size += own;
    } else parts.push({ texts: [story.text], size: opening + own });
  }
  const following = rest.length - unplaced.length;
  return {
    body: [
      ...head,
      ...(following ? [BATCH_DESCRIPTION_WORDS.continued(following)] : []),
      ...stories.slice(0, shown).map((story) => story.text),
    ].join(SEPARATOR),
    comments: parts.map((part, index) =>
      [
        BATCH_STORIES_MARKER,
        BATCH_DESCRIPTION_WORDS.part(index + 1, parts.length),
        ...part.texts,
      ].join(SEPARATOR),
    ),
    unplaced,
  };
}
