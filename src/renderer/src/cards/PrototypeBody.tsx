import { cardNavigationParts } from "@shared/cardParts";
import {
  cardDataNames,
  demoSources,
  playableDemoKind,
  viewablePictures,
} from "@shared/cardPictures";
import type { CardWidth } from "@shared/cards";
import { isPreviewBody, REVISION_TARGETS_MAX } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { wordSaidBody } from "@shared/i18n/said";
import type { FrameAnswers, FramePicture, FrameQuestioned } from "@shared/plugins/bridge";
import { FRAME_ALLOW, FRAME_SANDBOX } from "@shared/plugins/containment";
import { type FrameMount, type FrameTheme, frameTitle } from "@shared/plugins/frameDocument";
import { appBodyOf } from "@shared/welcome";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { available } from "../app/focusRecovery";
import { Button } from "../design";
import type { ViewerDemo } from "../design/cards/PictureViewer";
import { focusWithRing } from "../design/focus";
import { useFrameController } from "../plugins/frames/FrameMount";
import { windowGesture } from "../plugins/frames/frameActivation";
import type {
  FrameController,
  FrameInset,
  FrameMountSpec,
} from "../plugins/frames/frameController";
import { GESTURE_FOCUS_FRAMES, whenFrameHoldsFocus } from "../plugins/frames/frameFocus";
import { describeFocus, openFrameLink } from "../plugins/frames/frameLink";
import { dismissEmptyAnnotation, syncAnnotation, useAnnotationBridge } from "./annotationBridge";
import { CARD_BODY_WORDS } from "./cardBodyWords";
import { DrawnAtWidth } from "./drawnAtWidth";
import {
  type KnowledgeLinks,
  knowledgeReferenceGesture,
  useKnowledgeLinks,
} from "./knowledgeLinks";
import {
  buildPrototypeSrcdoc,
  CHANGE_GUTTER_PX,
  cardBodyHtml,
  cardBodyMarkup,
  cardBodyVehicle,
  cardStylesheet,
  escapeHtml,
  INSET_SPACER,
} from "./prototypeSrcdoc";
import { type RevealBody, revealInCard, useRevisionNavigation } from "./RevisionNavigation";
import { type TaskLinks, taskKeyGesture, useTaskLinks } from "./taskLinks";

const MIN_BODY_HEIGHT = 48;

/**
 * Let the frame grow to its full document height. ResponseCard owns the
 * viewport constraint and scroll surface; capping the frame here gave long
 * bodies a second, nested scrollbar.
 */
export function cardBodyHeight(reported: number, floor = MIN_BODY_HEIGHT): number {
  return Math.max(floor, Math.ceil(reported));
}

type BodyProps = {
  cardId?: string;
  /** Translate original offer offsets past host facts removed into the footer. */
  revisionStart?: (start: number) => number;
  revision?: {
    offerId: string;
    body: React.MutableRefObject<RevealBody | null>;
    returnFocus: () => boolean;
  };
  body: string;
  theme: FrameTheme;
  title: string;
  /**
   * The action ids this body may raise over the bridge: its card's actions
   * minus the effect-bearing ones, which are the host chrome's alone
   * (`bridgeActionIds`).
   */
  declaredActionIds: string[];
  /** The size the card is shown at: the document's `data-width`. */
  width?: CardWidth;
  /**
   * Where each part new since the captain last saw the card starts in
   * `body` (`Card.changes.marks`): each gets a change bar.
   */
  marks?: readonly number[];
  /** Settles with the action's outcome, which the bridge hands back to the body's `inf.action`. */
  onAction: (actionId: string, value?: unknown) => Promise<void>;
  /**
   * A picture in the body was clicked (card pictures, phase 3): its group's
   * pictures the viewer may show, which one, and the frame that opened
   * them, where focus returns when the viewer closes.
   */
  onPicture?: (
    set: { index: number; pictures: FramePicture[]; demo?: ViewerDemo },
    opener: HTMLIFrameElement | null,
    title?: string,
  ) => void;
  /**
   * The body's own form (inline decisions, contract 4.22): the draft each
   * new document gets back by name, and every reading the bridge posts.
   */
  form?: FrameMountSpec["form"];
  /**
   * Filled with the frame's fresh reading of its form, for the footer click
   * that sends it; undefined when the frame cannot give one.
   */
  collectRef?: React.MutableRefObject<CollectAnswers | null>;
  /** Filled with a way to step through the body's questions while it is mounted. */
  questionRef?: React.MutableRefObject<StepQuestions | null>;
  /** The body's own Enter stepped past its last question: focus goes to the card's buttons. */
  onQuestionEnd?: () => void;
  /**
   * Initialized drawing (or a usable error surface), for replacement
   * presentation: a page whose scripts have started, or that has none.
   */
  onDrawn?: () => void;
  /**
   * Whether the card is shown (docs/renderer.md, "Held preparation"): a
   * card's page is born held, and its scripts and animations start once it
   * is. A body the stage prepares before it is shown is not; absent, shown.
   */
  active?: boolean;
  /**
   * A scripted page the stage prepared drew held, its scripts not started
   * (`failed` when that page was refused or stopped instead: shown, the body
   * mounts afresh). It is not ready to show until its scripts ran and it
   * drew again (`onDrawn`).
   */
  onHeld?: (failed: boolean) => void;
  /** Each new document of the body was born (the stage's timing marks). */
  onBorn?: () => void;
  onInteraction?: () => void;
  /**
   * Whether the captain can act on this body now. A body the stage prepares
   * before it is shown, or keeps drawn while it leaves, raises no action,
   * link, picture or interaction (docs/renderer.md); absent, always.
   */
  admit?: () => boolean;
  /**
   * A starter in the body was pressed (`data-inf-draft`): the words to start
   * the message box with. Only the captain's own press reaches it - the
   * card on screen, its frame holding the window's focus. Absent, a press
   * does nothing.
   */
  onDraft?: (text: string) => void;
  /** Only a newly shown surface opts into its first body fade. */
  reveal?: boolean;
  /**
   * The host's own markup that leads the body inside its document, so it
   * scrolls away with it: a merge card's after-merge strip
   * (`afterMergeStrip.ts`). Change bars and revision offsets move past it.
   */
  lead?: string;
  /**
   * The chrome the card holds over the body's top right - a merge card's
   * risk chart (docs/card-authoring.md "The risk chart") - and the box to
   * keep clear until it is drawn (a body the stage prepares has no chrome
   * yet). Either one puts the spacer at the start of the body, so a body
   * keeps one document whether its chrome is drawn or not.
   */
  inset?: { from: React.RefObject<HTMLElement | null>; until: FrameInset; gap: number };
};

/**
 * The box a card's chrome holds over its body's top right, measured from
 * the frame's top and right edges in its own pixels: from the frame's right
 * edge to the chrome's left plus the gap, and from the frame's top to the
 * chrome's bottom. A card scaled while it grows into place, and a body
 * scrolled under its chrome, measure the same.
 */
function useChromeInset(
  wrapperRef: React.RefObject<HTMLDivElement | null>,
  from: React.RefObject<HTMLElement | null> | undefined,
  gap: number,
): FrameInset | undefined {
  const [inset, setInset] = useState<FrameInset>();
  const measure = useCallback(() => {
    const chrome = from?.current;
    const wrapper = wrapperRef.current;
    if (!chrome || !wrapper || wrapper.offsetWidth === 0) return;
    const box = wrapper.getBoundingClientRect();
    const scale = box.width / wrapper.offsetWidth;
    if (!(scale > 0)) return;
    const scroller = wrapper.closest<HTMLElement>("[data-card-body]");
    const top =
      box.top +
      ((scroller?.scrollTop ?? 0) + Number.parseFloat(getComputedStyle(wrapper).paddingTop)) *
        scale;
    const held = chrome.getBoundingClientRect();
    const next = {
      width: Math.max(0, Math.round((box.right - held.left) / scale) + gap),
      height: Math.max(0, Math.round((held.bottom - top) / scale)),
    };
    setInset((shown) =>
      shown && shown.width === next.width && shown.height === next.height ? shown : next,
    );
  }, [from, wrapperRef, gap]);
  // Every render: a revised line coming or going moves the body, resizing nothing.
  useLayoutEffect(() => measure());
  useLayoutEffect(() => {
    const chrome = from?.current;
    const wrapper = wrapperRef.current;
    if (!chrome || !wrapper) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(wrapper);
    // The title the chrome sits in: a title wrapping to another line moves the body.
    if (chrome.parentElement) observer.observe(chrome.parentElement);
    return () => observer.disconnect();
  }, [from, wrapperRef, measure]);
  return inset;
}

/**
 * The vehicles' own settings: the tasks the body names, which only a body
 * links (`useTaskLinks`), and the srcdoc vehicle's frame name, height floor
 * and in-place refresh, which only the fact strip beside a card's buttons
 * changes.
 */
type SrcdocProps = Omit<BodyProps, "inset"> & {
  /** The chrome's box over the document's top right, for its spacer (`FrameMountSpec.inset`). */
  frameInset?: FrameInset;
  frameTitle?: string;
  floor?: number;
  links?: TaskLinks;
  /** The knowledge entries the body cites (docs/knowledge.md, "References in an answer"). */
  knowledge?: KnowledgeLinks;
  /**
   * Keeps the first document and refreshes its markup in place
   * (`FrameMountSpec.markup`), so a press on the frame survives the body
   * changing under it.
   */
  inPlace?: boolean;
};

/**
 * Asks the body's frame for a fresh reading of its form; with
 * `focusUnpicked`, a reading that finds a required question unanswered
 * also puts focus on that question.
 */
export type CollectAnswers = (focusUnpicked?: boolean) => Promise<FrameAnswers | undefined>;

/**
 * A step through the questions the body asks (docs/keyboard.md, "Moving
 * between a card's questions"), from a key or the footer's stepper: `moved`
 * to a question, now in view; `end` past the last one; `none` when the
 * body asks none or does not answer.
 */
export type StepQuestions = (ask: {
  step: 1 | -1;
  unpicked: boolean;
  wrap: boolean;
  restart: boolean;
  keyboard: boolean;
}) => Promise<"moved" | "end" | "none">;

/** Brings the question a step landed on into the card's view. */
function landed(
  frame: HTMLIFrameElement | null,
  where: FrameQuestioned | undefined,
): "moved" | "end" | "none" {
  if (!where) return "none";
  if ("end" in where) return "end";
  if (!("top" in where) || !frame) return "none";
  revealInCard(frame, where.top);
  return "moved";
}

const frameStyle = (height: number): React.CSSProperties => ({
  width: "100%",
  height,
  border: "none",
  display: "block",
  background: "transparent",
});

/**
 * Hosts agent-authored HTML - verbatim, there is no sanitizer - while the
 * card chrome stays in React, over the same bridge v2 controller every frame
 * uses: declared actions round back, links go to the host, height follows
 * the document.
 *
 * Two vehicles, one sandbox. A body without a script is data and rides
 * srcdoc, rebuilt when the body changes. A body carrying the agent's own
 * inline `<script>` (WI-16) is mounted: the host serves the same markup at a
 * card host of its own with each inline script's hash pinned into that
 * document's CSP, and the frame watchdog tears the frame down if a script
 * wedges it. A body drawing in a project's own font is mounted too, so the
 * font engine reads that file in a renderer process of its own.
 */
export function HtmlCardBody({ inset: chrome, lead, ...saved }: BodyProps) {
  const navigation = useRevisionNavigation();
  const authored = useWordedBody(saved);
  const input = lead ? leadBody(authored, lead) : authored;
  const given: BodyProps = navigation?.offerId
    ? {
        ...input,
        body: `${cardBodyHtml(input.body)}<i hidden data-inf-revision-offer="${navigation.offerId}"></i>`, // i18n-exempt: not shown (markup)
        revision: {
          offerId: navigation.offerId,
          body: navigation.body,
          returnFocus: navigation.returnFocus,
        },
      }
    : input;
  // The task keys it writes link to their tasks (FI3-594), in either
  // vehicle - every recorded task's key, the card's own task's included.
  const links = useTaskLinks(given.body);
  // The knowledge it cites opens the Knowledge browser's inspector, where a build keeps knowledge.
  const knowledge = useKnowledgeLinks(given.body);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const measured = useChromeInset(wrapperRef, chrome?.from, chrome?.gap ?? 0);
  // The chrome's box rides its own spacer at the start of the body, so the
  // body's first lines flow around it and its later headings clear it
  // (`CARD_INSET_STYLE`); a change bar's offset moves past the spacer.
  const chromed = (body: BodyProps): SrcdocProps =>
    chrome
      ? {
          ...body,
          body: `${INSET_SPACER}${body.body}`,
          ...(body.marks ? { marks: body.marks.map((mark) => mark + INSET_SPACER.length) } : {}),
          frameInset: measured ?? chrome.until,
          revisionStart: (start) => (body.revisionStart?.(start) ?? start) + INSET_SPACER.length,
        }
      : body;
  const whole = chromed(given);
  const wholeMarks = whole.marks?.join(",") ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: wholeMarks stands for marks, a new array on every push
  const vehicle = useMemo(() => cardBodyVehicle(whole.body, whole.marks), [whole.body, wholeMarks]);
  // A body too large for its mount opens with its words, under one line
  // saying its drawings are off (INF-3887); nothing to retry.
  const props = vehicle === "words" ? chromed(leadBody(given, drawingsOffLine())) : whole;
  const marksKey = props.marks?.join(",") ?? "";
  // A body with change bars borrows a gutter from the card's padding for
  // them, and its frame moves its text right by as much: on screen the text
  // stays where it was. Either vehicle draws them: a body whose scripts only
  // move its figures is prose and is marked; a preview never carries marks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: marksKey stands for marks, a new array on every push
  const marked = useMemo(
    () => cardBodyMarkup(props.body, props.marks).marked,
    [props.body, marksKey],
  );
  // Keep the vertical inset outside the viewport whose height follows the
  // body. Inside it, a 100vh child plus padding reports viewport + padding
  // forever. Both vehicles share this inset; authored markup stays verbatim.
  return (
    <div
      ref={wrapperRef}
      style={{
        paddingBlock: "var(--space-1)",
        ...(marked ? { marginInlineStart: -CHANGE_GUTTER_PX } : {}),
      }}
    >
      {vehicle === "mount" ? (
        <ScriptedCardBody {...props} links={links} knowledge={knowledge} />
      ) : (
        <SrcdocCardBody {...props} links={links} knowledge={knowledge} />
      )}
    </div>
  );
}

/**
 * The body with the host's `lead` markup at its start, the author's
 * document after it as markup (a plain text body would otherwise read as
 * markup once led); its change bars and revision offsets move past the lead.
 */
/**
 * The body with each run of the app's own words worded in the window's
 * language (docs/i18n.md, "Saved facts"), its change bars and revision
 * places moved with it.
 */
function useWordedBody(
  saved: Omit<BodyProps, "inset" | "lead">,
): Omit<BodyProps, "inset" | "lead"> {
  const worded = useMemo(() => {
    const app = appBodyOf(saved.body);
    return app === undefined ? wordSaidBody(saved.body) : { body: app, at: () => 0 };
  }, [saved.body]);
  if (worded.body === saved.body) return saved;
  return {
    ...saved,
    body: worded.body,
    ...(saved.marks ? { marks: saved.marks.map(worded.at) } : {}),
    revisionStart: (start) => worded.at(saved.revisionStart?.(start) ?? start),
  };
}

/** The line over a body whose drawings are off, as markup in the body's own frame. */
function drawingsOffLine(): string {
  // i18n-exempt: not shown (markup); its words are the catalog's
  return `<p data-inf-drawings-off="" style="margin-top:0;color:var(--fg-3);font-size:var(--text-sm)">${escapeHtml(CARD_BODY_WORDS.drawingsOff)}</p>`;
}

function leadBody(input: Omit<BodyProps, "inset" | "lead">, lead: string): BodyProps {
  const at = lead.length;
  return {
    ...input,
    body: `${lead}${cardBodyHtml(input.body)}`,
    ...(input.marks ? { marks: input.marks.map((mark) => mark + at) } : {}),
    revisionStart: (start) => (input.revisionStart?.(start) ?? start) + at,
  };
}

/**
 * The frame's drawing reports, held to its width (./drawnAtWidth). A new
 * document starts over, and so does a frame that goes.
 */
function useDrawnAtWidth(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  documentKey: string | undefined,
): DrawnAtWidth {
  const [drawing] = useState(
    () =>
      new DrawnAtWidth({
        read: () => frameRef.current?.clientWidth,
        watch: (changed) => {
          const frame = frameRef.current;
          if (!frame) return () => {};
          const observer = new ResizeObserver(changed);
          observer.observe(frame);
          return () => observer.disconnect();
        },
      }),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: documentKey is the trigger
  useLayoutEffect(() => () => drawing.forget(), [drawing, documentKey]);
  return drawing;
}

function cardFrameSpec(
  props: SrcdocProps,
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  setHeight: (height: number) => void,
  drawing: DrawnAtWidth,
  onUnresponsive?: () => void,
  onDrawn?: (held: boolean) => void,
): FrameMountSpec {
  const admitted = () => props.admit?.() ?? true;
  const interaction = () => {
    if (admitted()) props.onInteraction?.();
  };
  // A gesture that opens something over the window or in the browser, or
  // moves the captain's focus, counts only from a frame that holds focus
  // (../plugins/frames/frameFocus).
  const fromCaptain = (then: () => void) => {
    if (admitted()) whenFrameHoldsFocus(() => frameRef.current, then);
  };
  return {
    pluginId: "host",
    reads: [],
    actions: props.declaredActionIds,
    // Only the data files this body names, as the host kept them.
    data: new Set(cardDataNames(props.body)),
    ...(props.width ? { width: props.width } : {}),
    ...(props.frameInset ? { inset: props.frameInset } : {}),
    // The action's own outcome goes back to the frame; a body the captain
    // cannot act on is refused, never silently taken.
    onAction: (actionId, value) =>
      admitted()
        ? props.onAction(actionId, value)
        : Promise.reject(new Error("This card is not the one on screen.")),
    onInteraction: interaction,
    onLiveChange: interaction,
    onResize: (reported) => setHeight(cardBodyHeight(reported, props.floor)),
    // A drawing counts at the frame's own width, once the frame is back at
    // it (./drawnAtWidth).
    onDrawn: (_height, width, held) => {
      if (onDrawn) drawing.report(width, () => onDrawn(held));
    },
    onBorn: () => {
      drawing.forget();
      props.onBorn?.();
      syncAnnotation(props.cardId);
    },
    // A link takes the captain out of the app, into the browser: only the
    // captain's own click or Enter on it. Each step that stops it says why
    // on the console (../plugins/frames/frameLink).
    onLink: (href) =>
      openFrameLink(href, {
        admitted,
        whenFocused: (then, otherwise) =>
          whenFrameHoldsFocus(() => frameRef.current, then, GESTURE_FOCUS_FRAMES, otherwise),
        focusedOn: () => describeFocus(document.activeElement),
        open: (address) => window.infinitary.app.openExternal(address),
      }),
    // Words for the message box move the captain's focus there: only his
    // own press, as a link opens only then.
    onDraft: (text) => fromCaptain(() => props.onDraft?.(text)),
    onImage: (index, pictures, _frame, asked) => {
      // A playable preview's drawings are its own controls' (INF-3107): a press opens
      // nothing from them, only the body's own script asking (`inf.picture`).
      const set = admitted()
        ? viewablePictures(index, pictures, asked === true || !isPreviewBody(props.body))
        : undefined;
      if (set) fromCaptain(() => props.onPicture?.(set, frameRef.current));
    },
    // A demo opens in the same viewer, over its poster: only a recording this
    // card's body names, and it plays at once only on the captain's own press
    // - the window's own gesture (`windowGesture`), which a body's script
    // cannot give.
    onDemo: (demo) => {
      const pressed = windowGesture();
      const kind = playableDemoKind(demo.src);
      if (!admitted() || !kind || !demoSources(props.body).has(demo.src)) return;
      const poster = viewablePictures(0, [demo.poster]);
      if (!poster) return;
      const { src, caption, durationMs } = demo;
      fromCaptain(() =>
        props.onPicture?.(
          { ...poster, demo: { src, kind, caption, durationMs, play: demo.play && pressed } },
          frameRef.current,
        ),
      );
    },
    // An Escape the body did not use leaves it for its card, ringed, from
    // where the reading keys scroll it and Tab goes back in.
    onEscape: () =>
      fromCaptain(() => {
        if (dismissEmptyAnnotation(props.cardId)) return;
        if (props.revision?.returnFocus()) return;
        const card = frameRef.current?.closest<HTMLElement>('[data-window-region="card"]');
        if (card && available(card)) focusWithRing(card, { preventScroll: true });
      }),
    ...(props.revision
      ? {
          revision: {
            offerId: props.revision.offerId,
            starts: cardNavigationParts(props.body)
              .slice(0, REVISION_TARGETS_MAX)
              .map((p) => p.start),
          },
        }
      : {}),
    ...(props.form ? { form: props.form } : {}),
    // The body's own Enter or Shift+Enter on a question moved its focus: the
    // card brings that question into view, or past the last one goes on
    // to the card's buttons.
    onQuestioned: (where) => {
      if (!admitted()) return;
      if (landed(frameRef.current, where) === "end") props.onQuestionEnd?.();
    },
    ...(props.links
      ? {
          taskKeys: props.links.keys,
          litKey: props.links.lit,
          onTask: (gesture, key, box) => {
            const links = props.links;
            if (!links) return;
            const run = () =>
              taskKeyGesture(gesture, key, box, {
                frame: frameRef.current,
                links,
                admitted: admitted(),
              });
            // Opening a task takes the stage: only the captain's own click or Enter.
            if (gesture === "open") fromCaptain(run);
            else run();
          },
        }
      : {}),
    ...(props.knowledge
      ? {
          entryRefs: props.knowledge.refs,
          onEntry: (id) => {
            const knowledge = props.knowledge;
            if (!knowledge) return;
            // Opening the browser takes the stage: only the captain's own click or Enter.
            fromCaptain(() =>
              knowledgeReferenceGesture(id, { links: knowledge, admitted: admitted() }),
            );
          },
        }
      : {}),
    ...(onUnresponsive ? { onUnresponsive } : {}),
  };
}

/**
 * Shows the body's page once the card is shown: whatever it held - its
 * scripts, its animations - starts (FrameController.activate). Before the
 * controller's first document is born, the activation waits for it.
 */
function useActivation(
  controllerRef: React.RefObject<FrameController | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    if (active) controllerRef.current?.activate();
  }, [active, controllerRef]);
}

/** Points the card's collect handle at this frame's controller while it is mounted. */
function useCollect(
  collectRef: BodyProps["collectRef"],
  controllerRef: React.RefObject<FrameController | null>,
  frameRef: React.RefObject<HTMLIFrameElement | null>,
): void {
  useEffect(() => {
    if (!collectRef) return;
    const collect: CollectAnswers = async (focusUnpicked) => {
      const controller = controllerRef.current;
      if (!controller) return undefined;
      const reading = await controller.collect();
      // Focus goes into the body only for a question it still waits on. A
      // frame's own script cannot take focus (FRAME_ALLOW), so the shell
      // gives the frame focus first, as a click on it would, and its bridge
      // then puts focus on the unanswered question. A default sent with
      // every answer given leaves focus in the window's own page: the send
      // may replace this body, and a key still on its way into a frame that
      // goes is never answered (INF-2927).
      if (focusUnpicked && reading && reading.answered < reading.of) {
        frameRef.current?.focus({ preventScroll: true });
        void controller.collect(true);
      }
      return reading;
    };
    collectRef.current = collect;
    return () => {
      if (collectRef.current === collect) collectRef.current = null;
    };
  }, [collectRef, controllerRef, frameRef]);
}

/** Points the card's question handle at this frame's controller while it is mounted. */
function useQuestions(
  questionRef: BodyProps["questionRef"],
  controllerRef: React.RefObject<FrameController | null>,
  frameRef: React.RefObject<HTMLIFrameElement | null>,
): void {
  useEffect(() => {
    if (!questionRef) return;
    const step: StepQuestions = async (ask) => {
      const controller = controllerRef.current;
      if (!controller) return "none";
      // A frame's own script cannot take focus (FRAME_ALLOW): a key's step
      // gives the frame focus first, and its bridge moves it to the question.
      if (ask.keyboard) frameRef.current?.focus({ preventScroll: true });
      return landed(frameRef.current, await controller.question(ask));
    };
    questionRef.current = step;
    return () => {
      if (questionRef.current === step) questionRef.current = null;
    };
  }, [questionRef, controllerRef, frameRef]);
}

/** A link can be pressed while the frame is still drawing its initial document. */
function frameDrawn(frame: HTMLIFrameElement): Promise<boolean> {
  if (frame.hasAttribute("data-frame-drawn")) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(ready);
    };
    const observer = new MutationObserver(() => {
      if (frame.hasAttribute("data-frame-drawn")) finish(true);
    });
    const timer = window.setTimeout(() => finish(false), 4000);
    observer.observe(frame, { attributes: true, attributeFilter: ["data-frame-drawn"] });
  });
}

function useBodyReveal(
  props: SrcdocProps,
  controllerRef: React.RefObject<FrameController | null>,
  frameRef: React.RefObject<HTMLIFrameElement | null>,
) {
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    const revision = props.revision;
    if (!revision) return;
    const reveal: RevealBody = async (offer, start, keyboard) => {
      const frame = frameRef.current;
      const admitted = () =>
        latest.current.revision?.offerId === offer &&
        (!latest.current.admit || latest.current.admit());
      if (!frame || !admitted() || !(await frameDrawn(frame)) || !admitted()) return false;
      if (keyboard) frame.focus({ preventScroll: true });
      const box = await controllerRef.current?.reveal(
        offer,
        latest.current.revisionStart?.(start) ?? start,
        keyboard,
      );
      if (!box || !admitted()) return false;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (
        !admitted() ||
        !frame.isConnected ||
        frame !== frameRef.current ||
        box.top > frame.offsetHeight ||
        box.height > frame.offsetHeight
      )
        return false;
      return revealInCard(frame, box.top, false, admitted);
    };
    revision.body.current = reveal;
    return () => {
      if (revision.body.current === reveal) revision.body.current = null;
    };
  }, [props.revision, controllerRef, frameRef]);
}

/**
 * A settle card's fact strip, above its buttons so it stays in view however
 * long the body is (`splitSettleFacts`): the vehicle a body without a script
 * rides, without the body's inset or floor, so it is exactly as tall as the
 * strip. It declares no actions; its pull request link opens like a body's.
 *
 * The host rewrites its facts while the card is up - the checks reading and
 * its age - and the strip takes them in place, in the one document it was
 * born with (FI3-1093): a new document under a press the captain started on
 * the link would end that press in another document, and no click comes.
 */
export function CardFactsFrame(props: {
  facts: string;
  theme: FrameTheme;
  title: string;
  width?: CardWidth;
}) {
  return (
    <SrcdocCardBody
      body={props.facts}
      theme={props.theme}
      title={props.title}
      frameTitle={`${props.title} facts`}
      floor={0}
      declaredActionIds={[]}
      onAction={() => Promise.resolve()}
      inPlace
      {...(props.width ? { width: props.width } : {})}
    />
  );
}

function SrcdocCardBody(props: SrcdocProps) {
  const { body, theme, title } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameName] = useState(() => crypto.randomUUID());
  const [height, setHeight] = useState(MIN_BODY_HEIGHT);
  const [drawnDocument, setDrawnDocument] = useState("");
  const [reveal] = useState(props.reveal ?? false);
  const marksKey = props.marks?.join(",") ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: marksKey stands for marks, a new array on every push
  const srcdoc = useMemo(
    () => buildPrototypeSrcdoc(body, theme, props.marks),
    [body, theme, marksKey],
  );

  // A new frame keeps its first document until that document has loaded. A
  // sandboxed frame is isolated in a process of its own, and a srcdoc swapped
  // in before its first navigation finishes leaves a document that never lays
  // out - height 0, blank - and no later srcdoc revives it. Once the first
  // load is in, every swap is safe at once. A frame refreshed in place never
  // swaps: its first document takes each new markup over the bridge.
  const [firstDocument] = useState(srcdoc);
  const [loaded, setLoaded] = useState(false);
  const shown = loaded && !props.inPlace ? srcdoc : firstDocument;
  // biome-ignore lint/correctness/useExhaustiveDependencies: marksKey stands for marks, a new array on every push
  const markup = useMemo(
    () => (props.inPlace ? cardBodyMarkup(body, props.marks).html : undefined),
    [props.inPlace, body, marksKey],
  );

  const [fadeDocument] = useState(srcdoc);
  const drawn = drawnDocument === shown;
  const fade = reveal && fadeDocument === shown;

  const drawing = useDrawnAtWidth(frameRef, shown);
  const controllerRef = useFrameController(
    frameRef,
    {
      ...cardFrameSpec(props, frameRef, setHeight, drawing, undefined, () => {
        setDrawnDocument(shown);
        // A first document drawn while the body has already moved on is not
        // the body the card is presenting; one refreshed in place is.
        if (shown === srcdoc || props.inPlace) props.onDrawn?.();
      }),
      ...(markup !== undefined ? { markup } : {}),
    },
    theme,
    shown,
  );
  useCollect(props.collectRef, controllerRef, frameRef);
  useQuestions(props.questionRef, controllerRef, frameRef);
  useBodyReveal(props, controllerRef, frameRef);
  useAnnotationBridge(
    props.cardId,
    props.body,
    controllerRef,
    frameRef,
    props.admit,
    props.revisionStart,
  );
  // A page without a script holds only its animations, so its held drawing
  // is the one the card shows.
  useActivation(controllerRef, props.active ?? true);

  return (
    <iframe
      ref={frameRef}
      name={frameName}
      title={props.frameTitle ?? m.cardBodyFrameTitle({ title })}
      sandbox={FRAME_SANDBOX}
      allow={FRAME_ALLOW}
      scrolling="no"
      srcDoc={shown}
      onLoad={() => setLoaded(true)}
      data-frame-drawn={drawn ? "" : undefined}
      data-frame-reveal={fade ? "" : undefined}
      style={{ ...frameStyle(height), opacity: drawn || !fade ? undefined : 0 }}
    />
  );
}

type MountState =
  | { phase: "pending" }
  | { phase: "mounted"; mount: FrameMount }
  | { phase: "failed" }
  | { phase: "stopped" };

function ScriptedCardBody(props: SrcdocProps) {
  const { body, theme, title } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameName] = useState(() => crypto.randomUUID());
  const [height, setHeight] = useState(MIN_BODY_HEIGHT);
  const [drawn, setDrawn] = useState(false);
  // Drawn while held: prepared, its scripts not started (`active`).
  const [heldDrawn, setHeldDrawn] = useState(false);
  const [reveal] = useState(props.reveal ?? false);
  const [state, setState] = useState<MountState>({ phase: "pending" });
  // Bumped by Retry: the only way back from a stopped frame is a fresh mount.
  const [attempt, setAttempt] = useState(0);
  const revealDocument = useRef<string | null>(null);
  const mountIdRef = useRef<string | null>(null);
  const active = props.active ?? true;
  const activeRef = useRef(active);
  activeRef.current = active;
  // A prepared page refused or stopped before the card was shown: shown, it
  // mounts afresh, as a card nobody prepared does, and Retry is that mount's.
  const preparedFailed = useRef(false);
  const failed = (phase: "failed" | "stopped") => {
    setState({ phase });
    if (activeRef.current) {
      props.onDrawn?.();
    } else {
      preparedFailed.current = true;
      props.onHeld?.(true);
    }
  };
  useEffect(() => {
    if (!active || !preparedFailed.current) return;
    preparedFailed.current = false;
    setAttempt((n) => n + 1);
  }, [active]);
  const marksKey = props.marks?.join(",") ?? "";
  // The bars ride the served markup as they ride srcdoc: an attribute on each
  // new part and a style block after the body, so no script's text changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: marksKey stands for marks, a new array on every push
  const template = useMemo(
    () => ({ html: cardBodyMarkup(body, props.marks).html }),
    [body, marksKey],
  );

  // One mount per body (and per retry). The theme at mount time seeds the
  // served document; later themes are pushed over the bridge, not re-mounted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is pushed, not re-mounted; attempt is the retry trigger
  useLayoutEffect(() => {
    let current = true;
    let mountId: string | null = null;
    setState({ phase: "pending" });
    setDrawn(false);
    setHeldDrawn(false);
    void window.infinitary.plugins
      .mountFrame({
        kind: "card",
        // A longer title is shortened to what the mount takes (INF-3887).
        title: frameTitle(title),
        theme,
        style: cardStylesheet(),
        // The markup the agent wrote, unchanged. The host finds its inline
        // scripts and pins each one's hash into that mount's own CSP.
        template,
      })
      .then((mount) => {
        mountId = mount.mountId;
        if (current) {
          mountIdRef.current = mount.mountId;
          setState({ phase: "mounted", mount });
        } else {
          void window.infinitary.plugins.unmountFrame(mount.mountId).catch(() => {});
        }
      })
      .catch(() => {
        // The host refused the mount: too many cards with drawings are open
        // (its card cap). A body over the size limit never asks (`cardBodyVehicle`),
        // so Retry, once one closes, asks again.
        if (current) failed("failed");
      });
    return () => {
      current = false;
      if (mountIdRef.current === mountId) mountIdRef.current = null;
      if (mountId) void window.infinitary.plugins.unmountFrame(mountId).catch(() => {});
    };
  }, [title, template, attempt]);

  const documentKey = state.phase === "mounted" ? state.mount.url : undefined;
  const drawing = useDrawnAtWidth(frameRef, documentKey);
  const controllerRef = useFrameController(
    frameRef,
    cardFrameSpec(
      props,
      frameRef,
      setHeight,
      drawing,
      () => {
        // Removing the iframe detaches the wedged document; the browser reaps
        // its dedicated process. The served document goes with it.
        const mountId = mountIdRef.current;
        mountIdRef.current = null;
        if (mountId) void window.infinitary.plugins.unmountFrame(mountId).catch(() => {});
        failed("stopped");
      },
      (held) => {
        if (held) {
          setHeldDrawn(true);
          props.onHeld?.(false);
          return;
        }
        if (revealDocument.current === null) revealDocument.current = mountIdRef.current;
        setDrawn(true);
        props.onDrawn?.();
      },
    ),
    theme,
    documentKey,
  );
  useCollect(props.collectRef, controllerRef, frameRef);
  useQuestions(props.questionRef, controllerRef, frameRef);
  useBodyReveal(props, controllerRef, frameRef);
  useAnnotationBridge(
    props.cardId,
    props.body,
    controllerRef,
    frameRef,
    props.admit,
    props.revisionStart,
  );
  useActivation(controllerRef, active);

  if (state.phase === "stopped" || state.phase === "failed") {
    return (
      <div
        data-card-body-stopped=""
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          minHeight: MIN_BODY_HEIGHT,
        }}
      >
        <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
          {state.phase === "stopped" ? CARD_BODY_WORDS.stopped : CARD_BODY_WORDS.failed}
        </p>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          {m.cardBodyRetry()}
        </Button>
      </div>
    );
  }
  if (state.phase === "pending") return <div data-frame-mount-pending="" style={{ height }} />;
  return (
    <iframe
      ref={frameRef}
      name={frameName}
      title={m.cardBodyFrameTitle({ title })}
      sandbox={FRAME_SANDBOX}
      allow={FRAME_ALLOW}
      scrolling="no"
      src={state.mount.url}
      data-frame-mount={state.mount.mountId}
      data-frame-drawn={drawn ? "" : undefined}
      data-frame-held={heldDrawn && !drawn ? "" : undefined}
      data-frame-reveal={reveal && revealDocument.current === state.mount.mountId ? "" : undefined}
      style={{
        ...frameStyle(height),
        opacity: drawn || !reveal || revealDocument.current !== null ? undefined : 0,
      }}
    />
  );
}

/** Kept as a compatibility alias for callers outside the renderer bundle. */
export const PrototypeBody = HtmlCardBody;
