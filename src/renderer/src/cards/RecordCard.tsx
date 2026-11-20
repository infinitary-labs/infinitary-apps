import type { DropTaskReview, TaskLifecycleOp } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { isSafeCardHref } from "@shared/linkify";
import type { FrameTheme } from "@shared/plugins/frameDocument";
import { recordBarOf } from "@shared/recordBar";
import { recordOffersCloseDone } from "@shared/recordCloseDone";
import { recordProofDemo, recordProofPictures } from "@shared/recordProof";
import { browserDriverOf } from "@shared/taskBrowser";
import { taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import { presentTask } from "@shared/taskWaiting";
import { taskWaitStatus } from "@shared/taskWaits";
import { RIGOR_LABELS } from "@shared/vocabulary";
import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { focusPanelCard } from "../app/shellCommands";
import type { RecordView } from "../app/stack";
import { useShellStore } from "../app/store";
import { useModelNames } from "../app/useModelNames";
import { useProjectFact } from "../character/crew/useCrewBoard";
import { ResponseCard } from "../design/cards/ResponseCard";
import { RecordCell, TaskFactRows, TaskFactStrip, useMinute } from "../design/core/TaskFacts";
import { TaskResourceUse } from "../design/core/TaskResourceUse";
import { recordTemplate } from "../plugins/builtin";
import { BUILTIN_PLUGIN_ID } from "../plugins/builtin/manifest";
import { FrameMount } from "../plugins/frames/FrameMount";
import { windowGesture } from "../plugins/frames/frameActivation";
import { whenFrameHoldsFocus } from "../plugins/frames/frameFocus";
import { pluginHost } from "../plugins/host";
import {
  knowledgeOpenSchema,
  openKnowledgeEntry,
  useKnowledgeHere,
} from "../plugins/point/openKnowledge";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { closeCardFindFrom } from "./cardFind";
import { recordOpenSections, recordReadingPlaceId, useCardReadingPlace } from "./cardReadingPlace";
import type { HtmlCardBody } from "./PrototypeBody";
import { RecordCost } from "./RecordCost";
import { RecordAttention, RecordDelivered, RecordGoal, RecordRelations } from "./RecordHead";
import { RecordPaneChrome, RecordPaneFooter } from "./RecordPaneChrome";
import { recordPillToneOf } from "./recordFooter";
import { useStageRole } from "./SurfaceReveal";
import { KeyedText } from "./TaskKey";
import { TaskTabStrip } from "./TaskTabStrip";
import { taskKeyGesture, useTaskLinks } from "./taskLinks";
import { taskTabFactsOf } from "./taskTabs";

/** The wire-less kind the built-in manifest dresses the record with. */
export const RECORD_CARD_KIND = "task-record";
/**
 * The record body's declared actions: a Cards row link (FI3-579 piece 1),
 * and where the window has knowledge a Knowledge used row (docs/knowledge.md,
 * "Knowledge used on a task"). Its buttons are the host's bar (FI3-565 piece
 * 4), never the body's; the task keys it writes are links the bridge draws
 * (FI3-1271).
 */
const BODY_ACTIONS: readonly string[] = ["open-card", "record-sections"];
const KNOWLEDGE_BODY_ACTIONS: readonly string[] = [...BODY_ACTIONS, "open-knowledge"];
/** Full intrinsic document height; ResponseCard owns the only scroll surface. */
const MAX_BODY_HEIGHT = Number.POSITIVE_INFINITY;
/** The frame may be all but empty on Info, where the window draws the body above it. */
const MIN_BODY_HEIGHT = 1;
/** How far a row's hover tint reaches past the card's left edge; record.html pads it back. */
const RECORD_ROW_BLEED_PX = 6;
/**
 * Every word the record's body may write, for the task keys in it
 * (FI3-1271): what the task waits on and holds up and its parent's key
 * first, then every string of its record - Activity, reports, its goal and
 * the captain's words among them.
 */
function recordWords(detail: TaskDetail | null, parentKey: string | undefined): string {
  if (!detail) return "";
  const words: string[] = [...detail.blockedBy, ...detail.blocks];
  if (parentKey) words.push(parentKey);
  const walk = (value: unknown): void => {
    if (typeof value === "string") words.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) walk(item);
  };
  walk(detail);
  return words.join("\n");
}

/** The name the window keeps the fold under the goal by, among the record's remembered rows. */
const WORDS_SECTION = "words";

const DELIVERY_WORDS: Record<string, string> = {
  get "direct-pr"() {
    return m.cardRecordDeliveryDirectPr();
  },
  get "queue-pr"() {
    return m.cardRecordDeliveryQueuePr();
  },
  get "local-only"() {
    return m.cardRecordDeliveryLocalOnly();
  },
  get "in-place"() {
    return m.cardRecordDeliveryInPlace();
  },
};

/**
 * The Delivery cell (INF-2261: "Pull request · Default care"): how the work
 * reaches the project and the care it takes, from the task's live policies,
 * or what its delivery recorded where it has none. Where each came from is
 * the More row's.
 */
function deliveryWordsOf(detail: TaskDetail): string {
  const mode = detail.policies?.delivery.value ?? detail.delivery?.mode;
  const care = detail.policies?.rigor.value ?? detail.rigor;
  return [
    ...(mode ? [DELIVERY_WORDS[mode] ?? mode] : []),
    ...(care ? [m.cardRecordCare({ care: RIGOR_LABELS[care] ?? care })] : []),
  ].join(" · ");
}

/** The key of the task `id` is part of, as its own record says it; undefined until read. */
function useParentKey(id: string | null): string | undefined {
  const [parent, setParent] = useState<{ id: string; key: string }>();
  useEffect(() => {
    if (!id) return;
    return appReadExecutor().subscribe(
      "tasks.detail",
      { id },
      { onValue: (value) => setParent({ id, key: (value as TaskDetail).key }), onError: () => {} },
    );
  }, [id]);
  return parent && parent.id === id ? parent.key : undefined;
}

/** A shell-held task view on the shared surface, with host lifecycle controls. */
export function RecordCard({
  taskId,
  theme,
  onDrawn,
  onPicture,
  view = "info",
}: {
  taskId: string;
  /** Which of the record's three tabs is shown: Info, Cards or Activity (INF-2261). */
  view?: RecordView;
  theme: FrameTheme;
  onDrawn: () => void;
  onPicture: ComponentProps<typeof HtmlCardBody>["onPicture"];
}) {
  const active = useStageRole() === "shown";
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [frameDrawn, setFrameDrawn] = useState(false);
  const modelName = useModelNames();
  const knowledge = useKnowledgeHere();
  const template = useMemo(() => recordTemplate(taskId, knowledge), [taskId, knowledge]);

  useEffect(() => {
    setDetail(null);
    setUnreadable(false);
    setFrameDrawn(false);
    return appReadExecutor().subscribe(
      "tasks.detail",
      { id: taskId },
      {
        onValue: (value) => setDetail(value as TaskDetail),
        onError: () => setUnreadable(true),
      },
    );
  }, [taskId]);

  useEffect(() => {
    if (!active || !detail?.filing || !detail.filingNew) return;
    void window.infinitary.tasks.opened(taskId).catch(() => {});
  }, [active, taskId, detail?.filing, detail?.filingNew]);

  // The task keys its body writes link to their tasks, its own key aside (FI3-1271).
  const parentKey = useParentKey(detail?.parentId ?? null);
  const words = useMemo(() => recordWords(detail, parentKey), [detail, parentKey]);
  const links = useTaskLinks(words, taskId);

  // The record is ready once its facts are loaded and its body frame has
  // drawn, or it could not be read. The card stays unseen until then, so it
  // appears at the height it keeps: revealing it on the facts alone drew an
  // empty card that grew and re-centred twice as the facts and then the
  // frame arrived (INF-510). The frame draws while the card is unseen; a
  // frame that never reports ends on the stage's hold limit, and the card
  // then appears as it is (FI3-948).
  const loaded = (detail !== null && frameDrawn) || unreadable;
  useEffect(() => {
    if (loaded) onDrawn();
  }, [loaded, onDrawn]);

  const detailRef = useRef(detail);
  detailRef.current = detail;
  // Show the card is a pointing gesture: the host brings the task's decision
  // card forward (`focusCard`) and writes nothing.
  const showCard = async () => {
    const current = detailRef.current;
    if (!current) return;
    if (current.requiredAction) await window.infinitary.task.run(current.id, "show-card");
    const fresh = await window.infinitary.tasks.detail(current.id);
    const shell = useShellStore.getState();
    const { waitingCardId } = presentTask(fresh, shell.cards);
    if (waitingCardId) shell.focusCard(waitingCardId);
  };
  // A Cards row link: an open card is focused where it is; a closed one is
  // brought forward through the shared show-card door as the read-only past
  // card. Only a card the task's own record lists, so a frame cannot ask for
  // any other. Nothing is written.
  const openCard = async (id: string, value: unknown) => {
    if (id === "open-knowledge") {
      // A Knowledge used row: that revision in the Knowledge browser's
      // inspector. It reads; the record and the use stay as they were.
      const entry = knowledgeOpenSchema.safeParse(value);
      if (entry.success) openKnowledgeEntry(entry.data, focusPanelCard);
      return;
    }
    if (id === "record-sections") {
      const open = (value as { open?: unknown } | null)?.open;
      if (Array.isArray(open)) {
        // The frame names its own rows; the fold under the goal is the window's.
        const words = (recordOpenSections.get(taskId) ?? []).filter((n) => n === WORDS_SECTION);
        recordOpenSections.set(taskId, [
          ...words,
          ...open.filter((n): n is string => typeof n === "string" && n !== WORDS_SECTION),
        ]);
      }
      return;
    }
    const cardId = (value as { id?: unknown } | null)?.id;
    if (id !== "open-card" || typeof cardId !== "string") return;
    const listed = detailRef.current?.cards.find((card) => card.id === cardId);
    if (!listed) return;
    if (listed.state === "open") useShellStore.getState().focusCard(cardId);
    else await window.infinitary.cards.showPast(cardId).catch(() => {});
  };
  const [optimisticStart, setOptimisticStart] = useState(false);
  const runOp = async (op: TaskLifecycleOp, review?: DropTaskReview) => {
    if (op === "start-task") setOptimisticStart(true);
    const result = await window.infinitary.task.run(taskId, op, review);
    if (!result.ok) {
      if (op === "start-task") setOptimisticStart(false);
      throw new Error(result.text);
    }
    // Start, Start again and Drop task leave the record on acknowledgement:
    // the host accepts a Start only once the task reads Starting, and a start
    // that fails after that says why in the feed and on this record when it
    // is opened again. A dropped task stays on its record, which the Tasks
    // panel opens again. A refusal stays here as the bar's inline line.
    // Closing a record the captain has paged away keeps the card they are on.
    if (op === "start-task" || op === "start-again" || op === "drop-task" || op === "stop-task")
      useShellStore.getState().closeTaskRecord(taskId);
  };
  const shown = useMemo(() => {
    if (!detail || !optimisticStart || detail.startAttempt || detail.status === "active") {
      return detail;
    }
    return { ...detail, startAttempt: { phase: "preparing" as const, since: Date.now() } };
  }, [detail, optimisticStart]);
  // Its project, with the repository beside it in a project of several (INF-4220).
  const projectFactWords = useProjectFact(shown?.projectId, shown?.repo?.name);
  const projectWords = shown?.repo ? projectFactWords : "";
  // The record's own reading of the start replaces the pressed copy.
  useEffect(() => {
    if (detail?.startAttempt || detail?.status === "active") setOptimisticStart(false);
  }, [detail]);

  const minute = useMinute();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const preparing =
      shown?.startAttempt?.phase === "preparing" ||
      shown?.startAttempt?.phase === "checking" ||
      shown?.activity === "starting";
    if (!preparing && !shown?.answerNoteId) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown?.startAttempt?.phase, shown?.activity, shown?.answerNoteId]);
  const meta = shown ? shown.key : unreadable ? m.cardRecordUnreadable() : "";
  // The crew summary's projection of the same read, so both say the same.
  const facts = useMemo(() => {
    if (!shown) return null;
    const read = taskFactsOf(shown, modelName);
    const base = {
      ...read,
      status: taskWaitStatus(shown, read.status, Math.max(clock, minute)),
    };
    const since =
      shown.startAttempt?.since ?? (shown.activity === "starting" ? shown.startedAt : null);
    const reason =
      shown.startAttempt?.phase === "checking"
        ? m.cardRecordChecking()
        : since != null &&
            clock - since >= 15_000 &&
            (shown.startAttempt?.phase === "preparing" || shown.activity === "starting")
          ? m.cardRecordStillStarting()
          : // Could not start is said beside Try again, in the bar.
            shown.startNotice
            ? ""
            : base.status.reason;
    return reason === base.status.reason ? base : { ...base, status: { ...base.status, reason } };
  }, [shown, modelName, clock, minute]);
  const openLink = (href: string) => {
    if (isSafeCardHref(href)) void window.infinitary.app.openExternal(href).catch(() => {});
  };

  const bodyRef = useCardReadingPlace(recordReadingPlaceId(taskId));
  // Read once per record: the frame takes its open rows at birth and reports
  // changes back; the shown tab follows the record's stack entry.
  const openAtBirth = useMemo(() => recordOpenSections.get(taskId) ?? [], [taskId]);
  const frameState = useMemo(() => ({ openSections: openAtBirth, view }), [openAtBirth, view]);
  const recordBody = useRef<HTMLDivElement>(null);
  const [wordsOpen, setWordsOpen] = useState(() => openAtBirth.includes(WORDS_SECTION));
  useEffect(() => {
    setWordsOpen((recordOpenSections.get(taskId) ?? []).includes(WORDS_SECTION));
  }, [taskId]);
  const toggleWords = (open: boolean) => {
    setWordsOpen(open);
    const rest = (recordOpenSections.get(taskId) ?? []).filter((n) => n !== WORDS_SECTION);
    recordOpenSections.set(taskId, open ? [WORDS_SECTION, ...rest] : rest);
  };
  return (
    <ResponseCard
      bodyRef={bodyRef}
      recordTaskId={taskId}
      width="100%"
      chrome={
        <RecordPaneChrome
          reading={facts?.status ?? null}
          pillTone={shown ? recordPillToneOf(shown) : "neutral"}
          taskKey={meta || null}
          title={facts?.title ?? ""}
          pin={
            shown?.key
              ? {
                  pinned: shown.pinnedAt !== undefined,
                  onToggle: () =>
                    void window.infinitary.task
                      .pin(taskId, shown.pinnedAt === undefined)
                      .catch(() => {}),
                }
              : undefined
          }
          tabs={
            shown && (
              <TaskTabStrip
                taskId={taskId}
                shown={view}
                browser={shown.browser}
                facts={taskTabFactsOf(shown)}
                captain={browserDriverOf(shown, shown.browser) === "captain"}
              />
            )
          }
        />
      }
      footer={
        shown && (
          <RecordPaneFooter
            bar={recordBarOf(shown)}
            effects={shown.dropEffects ?? null}
            taskId={taskId}
            taskKey={shown.key}
            revision={shown}
            notice={shown.startNotice ? `Could not start. ${shown.startNotice.reason}` : undefined}
            onRun={runOp}
            onShowCard={() => void showCard().catch(() => {})}
            move={{
              ...(shown.movable ? { movable: shown.movable } : {}),
              ...(shown.computerMove ? { computerMove: shown.computerMove } : {}),
              options: () => window.infinitary.task.moveOptions(taskId),
              move: (to, leaveBehind) =>
                leaveBehind
                  ? window.infinitary.task.move(taskId, to, { leaveBehind: true })
                  : window.infinitary.task.move(taskId, to),
            }}
            closeDone={{
              offered: recordOffersCloseDone(shown),
              close: () => window.infinitary.task.closeDone(taskId),
            }}
          />
        )
      }
    >
      <div data-record-card={taskId}>
        {/* Info (INF-2261), shaped like the hover preview: the attention
            sentence, the relations and the goal with the captain's words
            folded under it, the project, Now, Progress and the browser, then
            the row of facts under a hairline, Why this model, and the frame's
            one More row. Cards and Activity are the frame's alone. */}
        {view === "info" && facts && shown && (
          <div className="fm-record-facts" style={{ marginBottom: "var(--space-3)" }}>
            <RecordAttention detail={shown} onOpenChange={openLink} />
            <TaskFactRows
              facts={facts}
              lead={
                <>
                  <RecordDelivered detail={shown} />
                  <RecordRelations detail={shown} parentKey={parentKey} />
                  <RecordGoal detail={shown} open={wordsOpen} onToggle={toggleWords} />
                </>
              }
              {...(projectWords ? { project: projectWords } : {})}
              planView="list"
              omitStrip
              pullRequests
              nowWords={(text) => <KeyedText text={text} own={taskId} />}
              onOpenChange={openLink}
              onOpenBrowser={() => useShellStore.getState().openBrowserView(taskId)}
              focusable
            />
            <div className="fm-task-facts fm-record-strip" data-record-strip="">
              <TaskFactStrip
                facts={facts}
                onOpenChange={openLink}
                focusable
                why
                more={
                  <>
                    {deliveryWordsOf(shown) && (
                      <RecordCell label={m.cardRecordDelivery()} data-record-cell="delivery">
                        {deliveryWordsOf(shown)}
                      </RecordCell>
                    )}
                    {shown.runsOn && (
                      <RecordCell label={m.cardRecordRunsOn()} data-record-cell="runs-on">
                        {shown.runsOn.label}
                      </RecordCell>
                    )}
                    <TaskResourceUse taskId={taskId} />
                    {shown.cost && <RecordCost cost={shown.cost} />}
                  </>
                }
              />
            </div>
          </div>
        )}
        {/* The body frame reaches past the card's edges by the room its rows'
            hover tint takes, and pads it back (record.html), so the rows'
            labels start on the card's one left edge with Now and Progress
            (FI3-1159). */}
        <div ref={recordBody} data-record-body="" style={{ margin: `0 -${RECORD_ROW_BLEED_PX}px` }}>
          <FrameMount
            key={`${taskId}:${knowledge ? "knowledge" : ""}`}
            onMountError={() => {
              setUnreadable(true);
              onDrawn();
            }}
            title={m.cardRecordBodyTitle()}
            template={template}
            spec={{
              pluginId: BUILTIN_PLUGIN_ID,
              reads: pluginHost.declaredReads(BUILTIN_PLUGIN_ID),
              grant: pluginHost.grantOf(BUILTIN_PLUGIN_ID),
              actions: knowledge ? KNOWLEDGE_BODY_ACTIONS : BODY_ACTIONS,
              state: frameState,
              onDrawn: () => setFrameDrawn(true),
              // An Escape the record's page did not use closes Find in it
              // first, as one in a card's body does, and only while the page
              // holds focus (../plugins/frames/frameFocus); otherwise it does nothing.
              onEscape: () =>
                whenFrameHoldsFocus(
                  () => recordBody.current?.querySelector("iframe") ?? null,
                  () => void closeCardFindFrom(recordBody.current),
                ),
              onAction: (id, value) => void openCard(id, value),
              onLink: openLink,
              onImage: (index, pictures, frame) => {
                const set = recordProofPictures(detailRef.current?.liveValidation, index, pictures);
                if (set)
                  whenFrameHoldsFocus(
                    () => frame ?? null,
                    () => onPicture?.(set, frame ?? null, detailRef.current?.title),
                  );
              },
              onDemo: (demo, frame) => {
                const set = recordProofDemo(
                  detailRef.current?.liveValidation,
                  demo,
                  windowGesture(),
                );
                if (set)
                  whenFrameHoldsFocus(
                    () => frame ?? null,
                    () => onPicture?.(set, frame ?? null, detailRef.current?.title),
                  );
              },
              taskKeys: links.keys,
              litKey: links.lit,
              onTask: (gesture, key, box, frame) => {
                const run = () =>
                  taskKeyGesture(gesture, key, box, {
                    frame: frame ?? null,
                    links,
                    admitted: true,
                  });
                // Opening a task takes the stage: only the captain's own click or Enter.
                if (gesture === "open") whenFrameHoldsFocus(() => frame ?? null, run);
                else run();
              },
            }}
            theme={theme}
            layout="auto"
            minAutoHeight={MIN_BODY_HEIGHT}
            maxAutoHeight={MAX_BODY_HEIGHT}
          />
        </div>
      </div>
    </ResponseCard>
  );
}
