import type { LiveAttachment } from "@shared/cards";
import { PAGE_ATTACHMENT_WORDS } from "@shared/projectPage";
import {
  type AttachmentStanding,
  attachmentStanding,
  STALE_ATTACHMENT_LINE,
} from "@shared/taskBrowser";
import { browserLineOf, type TaskBrowserLine } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, MicroLabel } from "../design";
import { appReadExecutor } from "../plugins/reads/appExecutor";

/**
 * A card's live attachment (docs/task-browser.md, "From a card"; the design
 * skill's ResponseCard, "A live attachment"): host chrome between the body
 * and the buttons naming the task's browser - its site and who is driving,
 * or that the card's browser has stopped - with the crewmate's label as the
 * button that opens the view.
 *
 * The click is navigation: it brings the task's browser view to the front
 * of the stack and asks the core nothing, so it never answers the card,
 * runs no effect and leaves its merge where it was. The body's frame never
 * sees it.
 *
 * On a card that asks the captain to take the browser over (`handoff`,
 * docs/task-browser.md "Asking for help") the strip is attention while the
 * request stands, and his violet while he has control. It draws no button
 * there: the card's own open-browser action is its one way into the browser,
 * since a door beside it would open the page without answering the card.
 */
export function CardAttachment({
  cardId,
  attachment,
}: {
  cardId: string;
  attachment: LiveAttachment;
}) {
  return attachment.kind === "page" ? (
    <PageAttachment cardId={cardId} attachment={attachment} />
  ) : (
    <BrowserAttachment cardId={cardId} attachment={attachment} />
  );
}

function BrowserAttachment({
  cardId,
  attachment,
}: {
  cardId: string;
  attachment: Extract<LiveAttachment, { kind: "browser" }>;
}) {
  const { taskId, session, generation } = attachment;
  const [detail, setDetail] = useState<TaskDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    return appReadExecutor().subscribe(
      "tasks.detail",
      { id: taskId },
      { onValue: (value) => setDetail(value as TaskDetail), onError: () => setDetail(null) },
    );
  }, [taskId]);

  return (
    <CardAttachmentStrip
      attachment={attachment}
      reading={attachmentReading(attachment, detail)}
      onOpen={() =>
        useShellStore.getState().openBrowserView(taskId, { cardId, session, generation })
      }
    />
  );
}

/** What the strip says: whether the card's browser is still the task's, and if so its line. */
export type AttachmentReading = { standing: AttachmentStanding; line: TaskBrowserLine | null };

/**
 * The strip's reading from the task's record: until the record answers, the
 * card's browser is taken as still the task's and no line is drawn.
 */
export function attachmentReading(
  attachment: LiveAttachment,
  detail: TaskDetail | null,
): AttachmentReading {
  if (!detail || attachment.kind !== "browser") return { standing: "same", line: null };
  const fact = detail.browser;
  const standing = attachmentStanding(attachment, fact);
  return { standing, line: standing === "same" && fact ? browserLineOf(fact, detail) : null };
}

/** A request card's strip, by who holds its browser: attention while it waits, his violet while he drives. */
const HANDOFF_TINT: Partial<Record<NonNullable<TaskBrowserLine["driver"]>, string>> = {
  waiting: "var(--warn-dim)",
  taking: "var(--captain-dim)",
  captain: "var(--captain-dim)",
};

/** The strip itself, drawn from its reading. */
export function CardAttachmentStrip({
  attachment,
  reading,
  onOpen,
}: {
  attachment: LiveAttachment;
  reading: AttachmentReading;
  onOpen: () => void;
}) {
  const { line, standing } = reading;
  const handoff = attachment.kind === "browser" && attachment.handoff;
  const tint =
    handoff && standing === "same" && line?.driver ? HANDOFF_TINT[line.driver] : undefined;
  return (
    <div
      data-card-attachment={attachment.kind}
      data-attachment-task={attachment.taskId}
      data-attachment-standing={standing}
      data-attachment-handoff={handoff ? (tint ? line?.driver : "done") : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
        fontSize: "var(--text-xs)",
        ...(tint
          ? { background: tint, borderRadius: "var(--radius-m)", padding: "var(--space-2)" }
          : {}),
      }}
    >
      <MicroLabel style={{ flexShrink: 0 }}>Browser</MicroLabel>
      <span
        data-attachment-line=""
        data-browser-driver={line ? (line.driver ?? "stopped") : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: "var(--fg-3)",
        }}
      >
        {line ? (
          <>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
              {line.site}
            </span>{" "}
            · {line.words}
          </>
        ) : standing === "same" ? null : (
          STALE_ATTACHMENT_LINE
        )}
      </span>
      {handoff ? null : (
        <Button variant="secondary" size="sm" style={{ flexShrink: 0 }} onClick={onOpen}>
          {attachment.label}
        </Button>
      )}
    </div>
  );
}

/**
 * A card's page from its task's project (docs/task-browser.md, "A page from
 * the project"; the design skill's ResponseCard, "A live attachment"): the
 * same strip, naming the file, with the crewmate's label as the button that
 * asks this Mac's core to open it in the task's own browser with the captain
 * in control, then brings that browser's view to the front. The click
 * answers nothing and leaves the card as it was; when the core does not
 * open the page, the line says why until the next click.
 */
function PageAttachment({
  cardId,
  attachment,
}: {
  cardId: string;
  attachment: Extract<LiveAttachment, { kind: "page" }>;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const open = () => {
    setOpening(true);
    window.infinitary.cards
      .openPage(cardId)
      .then(
        (answer) => {
          setRefusal(answer.refusal ?? null);
          if (answer.browser) {
            useShellStore
              .getState()
              .openBrowserView(attachment.taskId, { cardId, ...answer.browser });
          }
        },
        (caught: unknown) =>
          setRefusal(caught instanceof Error && caught.message ? caught.message : null),
      )
      .finally(() => setOpening(false));
  };
  return (
    <PageAttachmentStrip
      attachment={attachment}
      refusal={refusal}
      opening={opening}
      onOpen={open}
    />
  );
}

/** The page strip itself: the file and what a click does, or why the last click did not open it. */
export function PageAttachmentStrip({
  attachment,
  refusal,
  opening,
  onOpen,
}: {
  attachment: Extract<LiveAttachment, { kind: "page" }>;
  refusal: string | null;
  opening: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      data-card-attachment={attachment.kind}
      data-attachment-task={attachment.taskId}
      data-attachment-refused={refusal ? "" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
        fontSize: "var(--text-xs)",
      }}
    >
      <MicroLabel style={{ flexShrink: 0 }}>Browser</MicroLabel>
      <span
        data-attachment-line=""
        title={refusal ?? undefined}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: refusal ? "var(--fg-2)" : "var(--fg-3)",
        }}
      >
        {refusal ?? (
          <>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
              {attachment.path}
            </span>{" "}
            · {PAGE_ATTACHMENT_WORDS}
          </>
        )}
      </span>
      <Button
        variant="secondary"
        size="sm"
        style={{ flexShrink: 0 }}
        disabled={opening}
        onClick={onOpen}
      >
        {attachment.label}
      </Button>
    </div>
  );
}
