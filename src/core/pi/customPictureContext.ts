import {
  type AgentSession,
  type SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

export const COMPACTED_PICTURES_NOTICE =
  "Earlier pictures are no longer in the active conversation after compaction. This text summary does not retain their visual detail. Reopen any pictures you still need to inspect.";

/**
 * Annotate Pi's summary, never its original saved messages. The saved boundary
 * and original entries prove the loss again on resume. Pi still owns the cut,
 * summary and retained context; normal requests never drop or rewrite pictures.
 */
export function customPictureContext(manager: SessionManager) {
  const summaries = new WeakMap<object, AgentSession["messages"][number]>();
  return (messages: AgentSession["messages"]): AgentSession["messages"] => {
    if (!messages.some((message) => message.role === "compactionSummary")) return messages;
    return messages.map((message) => {
      if (message.role !== "compactionSummary") return message;
      const cached = summaries.get(message);
      if (cached) return cached;
      // Read history only when a new compaction summary appears, not on every
      // request. Use Pi's context owner rather than recreating its cut rules.
      const retained = new Set(manager.buildContextEntries().map((entry) => entry.id));
      const lostPictures = manager
        .getBranch()
        .some(
          (entry) =>
            !retained.has(entry.id) &&
            sessionEntryToContextMessages(entry).some(
              (earlier) =>
                "content" in earlier &&
                Array.isArray(earlier.content) &&
                earlier.content.some((block) => block.type === "image"),
            ),
        );
      const annotated = lostPictures
        ? { ...message, summary: `${message.summary}\n\n${COMPACTED_PICTURES_NOTICE}` }
        : message;
      summaries.set(message, annotated);
      return annotated;
    });
  };
}
