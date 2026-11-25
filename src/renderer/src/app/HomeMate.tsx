import { HERE } from "@shared/deviceNames";
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { CrewOrbit } from "../character/crew/CrewOrbit";
import { crewOrbit } from "../character/crew/crewSignal";
import type { SummaryRoom } from "../character/crew/hover";
import { useCrewBoard } from "../character/crew/useCrewBoard";
import { requestStageClearedFidget } from "../character/emoteSignal";
import { Firstmate } from "../character/Firstmate";
import { setCharacterPaintHidden } from "../character/paintHidden";
import { motionToken } from "../design/motion";
import { RAIL_CONTENTS_SELECTOR } from "../plugins/railRoom";
import { useCardUp } from "./LastTurn";
import { useProjectFocus } from "./projectFocus";
import { STAGE_LIFT_EASE, STAGE_TOP } from "./stage/entryView";
import { cardPresses, clearedByPress } from "./stageCleared";
import { useShellStore } from "./store";

/**
 * Where a crewmate's summary may sit: the mate is painted behind the rails'
 * panels, the top bar and the input, so the summary keeps to the open window
 * between the bar and the input and never goes under a panel.
 */
function crewSummaryRoom(): SummaryRoom {
  const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
  return {
    within: {
      left: 0,
      right: window.innerWidth,
      top: box("[data-topbar]")?.bottom ?? 0,
      bottom: box("[data-prompt-dock]")?.top ?? window.innerHeight,
    },
    avoid: [...document.querySelectorAll(RAIL_CONTENTS_SELECTOR)].map((panel) => {
      const { left, top, right, bottom } = panel.getBoundingClientRect();
      return { left, top, right, bottom };
    }),
  };
}

/** Reduced motion supplies no later frame after rail folds or an intrinsic
 * panel resize, so the room follows its layout independently of stage time. */
function observeCrewSummaryRoom(changed: () => void): () => void {
  let watched = new Set<Element>();
  const sizes = new ResizeObserver(changed);
  const changes = new MutationObserver(() => {
    watch();
    changed();
  });
  const watch = () => {
    const next = new Set(
      document.querySelectorAll(
        `${RAIL_CONTENTS_SELECTOR}, [data-rail], [data-topbar], [data-prompt-dock]`,
      ),
    );
    for (const element of watched) if (!next.has(element)) sizes.unobserve(element);
    for (const element of next) if (!watched.has(element)) sizes.observe(element);
    watched = next;
    changes.disconnect();
    for (const region of document.querySelectorAll(
      "[data-rail], [data-topbar], [data-prompt-dock]",
    )) {
      changes.observe(region, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "style",
          "class",
          "hidden",
          "data-side-panel-collapsed",
          "data-side-panel-folded",
          "data-side-panel-placement-y",
        ],
      });
    }
    // Root attributes carry folding, text direction and prompt-lift variables.
    changes.observe(document.documentElement, { attributes: true });
  };
  watch();
  return () => {
    sizes.disconnect();
    changes.disconnect();
  };
}

/**
 * Whether the first mate listens: hold-to-talk is recording, or the main
 * message has a draft. Only whether, so typing never re-renders the stage.
 */
export const useListening = () => useShellStore((s) => s.recording || s.inputText.length > 0);

/** The keystroke count, read by the character's own frame: typing never renders the stage. */
const readKick = () => useShellStore.getState().kick;

/**
 * Character, window-centred, painted behind the rails and cards, with its
 * crew in orbit around it; the mounted frame fades to hidden under cards.
 */
export const HomeMate = memo(function HomeMate() {
  const orbit = crewOrbit();
  const thisMac = useShellStore((s) => s.thisMac);
  const homeName = thisMac?.role === "view" ? thisMac.name : HERE.This;
  useSyncExternalStore(orbit.subscribe, () => orbit.version);
  useEffect(() => {
    let heard = false;
    const off = window.infinitary.devices.onDevices((devices) => {
      heard = true;
      orbit.configure(devices, homeName);
    });
    void window.infinitary.devices.list().then(
      (devices) => {
        if (!heard) orbit.configure(devices, homeName);
      },
      () => undefined,
    );
    return off;
  }, [orbit, homeName]);
  // The captain's own press cleared the stage: the first mate plays a fidget.
  useEffect(
    () =>
      useShellStore.subscribe((s, prev) => {
        if (
          s.cards === prev.cards &&
          s.records === prev.records &&
          s.heldBackCardIds === prev.heldBackCardIds
        )
          return;
        if (clearedByPress(prev, s, cardPresses(), Date.now())) requestStageClearedFidget();
      }),
    [],
  );
  const listening = useListening();
  const submitted = useShellStore((s) => s.submitted);
  const firstmateBusy = useShellStore((s) => s.firstmateBusy);
  const firstmateFolding = useShellStore((s) => s.firstmateFolding);
  const firstmateFoldStarts = useShellStore((s) => s.firstmateFoldStarts);
  const showCards = useCardUp();
  const { names, facts } = useCrewBoard();
  // The project in light (docs/project-focus.md): the pill a pointer or the
  // keyboard rests on in the open row, else the focus; All projects lights all.
  const { focus, rest } = useProjectFocus();
  const litProject = rest !== null ? (rest === "all" ? null : rest) : focus;
  const crewFocus = useMemo(
    () => ({
      project: litProject,
      projectOf: (taskId: string) => facts[taskId]?.task.projectId,
    }),
    [litProject, facts],
  );
  const openRecord = useShellStore((s) => s.openRecord);
  const showNames = useShellStore((s) => s.showCrewModelNames);
  const theme = useShellStore((s) => s.theme);
  // Naming the colors for someone new (docs/first-launch.md): only once the
  // core has read the record, and only for the words not yet taught.
  const workingTaught = useShellStore((s) => s.firstRun?.workingWordAt !== null);
  const idleTaught = useShellStore((s) => s.firstRun?.idleWordAt !== null);
  const recordRead = useShellStore((s) => s.firstRun !== null);
  const noteCrewWord = useShellStore((s) => s.noteCrewWord);
  const teach = useMemo(
    () =>
      recordRead && !(workingTaught && idleTaught)
        ? {
            taught: { working: workingTaught, idle: idleTaught },
            onTaught: noteCrewWord,
          }
        : null,
    [recordRead, workingTaught, idleTaught, noteCrewWord],
  );
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showCards) {
      setCharacterPaintHidden(false);
      return;
    }
    const frame = frameRef.current;
    const duration = frame ? motionToken(frame, "--dur-slow") : 0;
    if (duration <= 0) {
      setCharacterPaintHidden(true);
      return;
    }
    const timer = window.setTimeout(() => setCharacterPaintHidden(true), duration);
    return () => window.clearTimeout(timer);
  }, [showCards]);
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        ref={frameRef}
        data-character-frame=""
        inert={showCards}
        style={{
          position: "absolute",
          left: "50%",
          top: STAGE_TOP,
          transform: "translate(-50%,-50%)",
          opacity: showCards ? 0 : 1,
          visibility: showCards ? "hidden" : "visible",
          transition: `opacity var(--dur-slow) var(--ease-out), visibility 0s ${showCards ? "var(--dur-slow)" : "0s"},${STAGE_LIFT_EASE}`,
        }}
      >
        <CrewOrbit
          model={orbit}
          names={showNames ? names : undefined}
          facts={facts}
          onOpen={openRecord}
          summaryRoom={crewSummaryRoom}
          observeSummaryRoom={observeCrewSummaryRoom}
          interactive={!showCards}
          theme={theme}
          teach={teach}
          focus={crewFocus}
        >
          <Firstmate
            listening={listening}
            busy={firstmateBusy}
            folding={firstmateFolding}
            foldStarts={firstmateFoldStarts}
            hidden={showCards}
            size={300}
            kick={readKick}
            submitSignal={submitted}
            theme={theme}
          />
        </CrewOrbit>
      </div>
    </div>
  );
});
