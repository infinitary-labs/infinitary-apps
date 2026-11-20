import type { CardMutation } from "@shared/cards";
import type { OwnCardWrite } from "./cardEmit";

/**
 * The tool text of one shared-card write (docs/card-threads.md, "Shared
 * cards"), read from the typed result the host saved, so the words never
 * claim more than the write did: a refusal says nothing changed, a held
 * write says when the captain sees it, and no receipt says it was read.
 */
export function cardMutationText(mutation: CardMutation): string {
  const card = mutation.title ? `"${mutation.title}" (${mutation.cardId})` : mutation.cardId;
  const reference = [
    mutation.revision
      ? `Its current revision is ${mutation.revision}${mutation.lifecycleId ? ` in lifecycle ${mutation.lifecycleId}` : ""}.`
      : "",
    mutation.generation !== undefined
      ? `Its required action is at generation ${mutation.generation}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tail = (parts: string[]) => parts.filter(Boolean).join(" ");
  const repeated = mutation.repeated
    ? "This operation identity already ran; this is its earlier result."
    : "";
  switch (mutation.effect) {
    case "refused":
      return tail([
        `Nothing changed on card ${card}: ${mutation.refusal ?? "refused."}`,
        reference,
      ]);
    case "unchanged":
      return tail([repeated, `Card ${card} is unchanged: it already says that.`, reference]);
    case "created":
      return tail([repeated, `Card shown: ${card}.`, reference]);
    case "revised":
      return tail([
        repeated,
        `Revised card ${card} as ${mutation.contributor.label}.`,
        reference,
        mutation.unchanged?.length ? `Kept as they were: ${mutation.unchanged.join(", ")}.` : "",
        lineWords(mutation),
        mutation.display === "held"
          ? "The captain sees the new version when your turn ends."
          : "The captain can see it now.",
      ]);
    case "reply-only":
      return tail([
        repeated,
        `Wrote on the thread of card ${card} as ${mutation.contributor.label}.`,
        lineWords(mutation),
        mutation.unchanged?.length
          ? `The card itself is unchanged (${mutation.unchanged.join(", ")}).`
          : "",
      ]);
  }
}

/**
 * What the first mate's thread line on its own card did (INF-5202), so it
 * never writes the same answer twice: empty when the write added no line.
 */
export function ownCardLineWords(write: OwnCardWrite): string {
  return write.line ? lineWords(write.line, write.stillOpen) : "";
}

/** What the thread line a write added does to the captain's questions. */
function lineWords(
  mutation: Pick<
    CardMutation,
    "replyId" | "answered" | "alreadyAnswered" | "clarification" | "responseId"
  >,
  stillOpen?: number,
): string {
  if (mutation.replyId === undefined) return "";
  const line = `Your line is message ${mutation.replyId}`;
  const response = mutation.responseId
    ? ` It carries response ${mutation.responseId}; the first mate hears it once.`
    : "";
  if (mutation.clarification) {
    return `${line}, a dated clarification on the closed card; it reopens nothing and changes no choice.${response}`;
  }
  if (mutation.answered !== undefined) {
    return `${line}; it answers the captain's message ${mutation.answered} and ends that question.${response}`;
  }
  if (mutation.alreadyAnswered) {
    return `${line}, added as a comment: ${mutation.alreadyAnswered.by} had already answered the captain's message ${mutation.alreadyAnswered.messageId} ("${mutation.alreadyAnswered.text}").${response}`;
  }
  if (stillOpen !== undefined) {
    return `${line}, a comment: it named no message in answers_message, so the captain's message ${stillOpen} is still open.${response}`;
  }
  return `${line}, a comment; it ends no question.${response}`;
}
