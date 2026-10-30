import type { DropTaskReview, TaskLifecycleOp } from "@shared/cards";
import { isSafeCardHref } from "@shared/linkify";
import type { FrameTheme } from "@shared/plugins/frameDocument";
import { recordBarOf } from "@shared/recordBar";
import { recordProofDemo, recordProofPictures } from "@shared/recordProof";
import { browserDriverOf } from "@shared/taskBrowser";
import { taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import { presentTask } from "@shared/taskWaiting";
import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react";
import { focusPanelCard } from "../app/shellCommands";
import { useShellStore } from "../app/store";
import { useModelNames } from "../app/useModelNames";
import { ResponseCard } from "../design/cards/ResponseCard";
import { hasFactStrip, TaskFactRows, TaskFactStrip } from "../design/core/TaskFacts";
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
import { recordOpenSections, recordReadingPlaceId, useCardReadingPlace } from "./cardReadingPlace";
import type { HtmlCardBody } from "./PrototypeBody";
import { RecordPaneChrome, RecordPaneFooter } from "./RecordPaneChrome";
import { recordPillToneOf } from "./recordFooter";
import { useStageRole } from "./SurfaceReveal";
import { KeyedText } from "./TaskKey";
import { TaskTabStrip } from "./TaskTabStrip";
import { taskKeyGesture, useTaskLinks } from "./taskLinks";
import { hasCrewmateTab } from "./taskTabs";

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
const MIN_BODY_HEIGHT = 48;
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
  onClose,
  onDrawn,
  onPicture,
}: {
  taskId: string;
  theme: FrameTheme;
  onClose: () => void;
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
      if (Array.isArray(open))
        recordOpenSections.set(
          taskId,
          open.filter((n) => typeof n === "string"),
        );
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
  // The record's own reading of the start replaces the pressed copy.
  useEffect(() => {
    if (detail?.startAttempt || detail?.status === "active") setOptimisticStart(false);
  }, [detail]);

  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const preparing =
      shown?.startAttempt?.phase === "preparing" ||
      shown?.startAttempt?.phase === "checking" ||
      shown?.activity === "starting";
    if (!preparing) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown?.startAttempt?.phase, shown?.activity]);
  const meta = shown ? shown.key : unreadable ? "this record could not be read" : "";
  // The crew summary's projection of the same read, so both say the same.
  const facts = useMemo(() => {
    if (!shown) return null;
    const base = taskFactsOf(shown, modelName);
    const since =
      shown.startAttempt?.since ?? (shown.activity === "starting" ? shown.startedAt : null);
    const reason =
      shown.startAttempt?.phase === "checking"
        ? "Checking whether it started"
        : since != null &&
            clock - since >= 15_000 &&
            (shown.startAttempt?.phase === "preparing" || shown.activity === "starting")
          ? "Still starting. You can keep working."
          : shown.startNotice
            ? `Could not start. ${shown.startNotice.reason}`
            : base.status.reason;
    return reason === base.status.reason ? base : { ...base, status: { ...base.status, reason } };
  }, [shown, modelName, clock]);
  const openLink = (href: string) => {
    if (isSafeCardHref(href)) void window.infinitary.app.openExternal(href).catch(() => {});
  };

  const bodyRef = useCardReadingPlace(recordReadingPlaceId(taskId));
  // Read once per record: the frame takes it at birth and reports changes back.
  const birthState = useMemo(
    () => ({ openSections: recordOpenSections.get(taskId) ?? [] }),
    [taskId],
  );
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
          tabs={
            shown && (
              <TaskTabStrip
                taskId={taskId}
                shown="info"
                browser={shown.browser}
                crewmate={hasCrewmateTab(shown)}
                captain={browserDriverOf(shown, shown.browser) === "captain"}
              />
            )
          }
          onClose={onClose}
        />
      }
      footer={
        shown && (
          <>
            {facts && hasFactStrip(facts) && (
              <div className="fm-task-facts fm-record-strip" data-record-strip="">
                <TaskFactStrip facts={facts} onOpenChange={openLink} focusable why />
              </div>
            )}
            <RecordPaneFooter
              bar={recordBarOf(shown)}
              effects={shown.dropEffects ?? null}
              taskId={taskId}
              taskKey={shown.key}
              revision={shown}
              onRun={runOp}
              onShowCard={() => void showCard().catch(() => {})}
              move={{
                ...(shown.movable ? { movable: shown.movable } : {}),
                ...(shown.computerMove ? { computerMove: shown.computerMove } : {}),
                options: () => window.infinitary.task.moveOptions(taskId),
                move: (to) => window.infinitary.task.move(taskId, to),
              }}
            />
          </>
        )
      }
    >
      <div data-record-card={taskId}>
        {facts && (
          <div className="fm-record-facts" style={{ marginBottom: "var(--space-3)" }}>
            <TaskFactRows
              facts={facts}
              planView="list"
              omitStrip
              nowWords={(text) => <KeyedText text={text} own={taskId} />}
              onOpenChange={openLink}
              onOpenBrowser={() => useShellStore.getState().openBrowserView(taskId)}
              focusable
            />
            <TaskResourceUse taskId={taskId} />
          </div>
        )}
        {/* The body frame reaches past the card's edges by the room its rows'
            hover tint takes, and pads it back (record.html), so the rows'
            labels start on the card's one left edge with Now and Progress
            (FI3-1159). */}
        <div data-record-body="" style={{ margin: `0 -${RECORD_ROW_BLEED_PX}px` }}>
          <FrameMount
            key={`${taskId}:${knowledge ? "knowledge" : ""}`}
            onMountError={() => {
              setUnreadable(true);
              onDrawn();
            }}
            title="Task record body"
            template={template}
            spec={{
              pluginId: BUILTIN_PLUGIN_ID,
              reads: pluginHost.declaredReads(BUILTIN_PLUGIN_ID),
              grant: pluginHost.grantOf(BUILTIN_PLUGIN_ID),
              actions: knowledge ? KNOWLEDGE_BODY_ACTIONS : BODY_ACTIONS,
              state: birthState,
              onDrawn: () => setFrameDrawn(true),
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
