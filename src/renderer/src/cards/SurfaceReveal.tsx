import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { readingScrollTop } from "./cardKeys";

const EntranceContext = createContext(false);
const StageRoleContext = createContext<StageRole>("shown");
export const useStageRole = () => useContext(StageRoleContext);
/** Whether the entry can take focus now: shown and ready, so not inert. */
const StageFocusableContext = createContext(true);
export const useStageFocusable = () => useContext(StageFocusableContext);
let initialSurfacePainted = false;
const BodyEntranceContext = createContext({ reveal: false, onDrawn: () => {} });

/** What a stack entry is on the stage (`stageSlots.ts`). */
export type StageRole = "shown" | "warm" | "outgoing" | "parked";

/**
 * One stack entry on the stage, keyed by entry id - never by revision,
 * geometry or pager state - so a prepared entry is promoted in place and a
 * shown one stays mounted while it leaves. Entrance eligibility is captured
 * at birth: only an entry born shown on an empty stage after the boot read
 * takes the surface entrance; a replacement crossfades instead
 * (docs/renderer.md). Only the shown entry is the card: a prepared
 * successor and a leaving drawing are inert and hidden from assistive
 * technology. The shown entry is the selected card even before it is ready
 * to appear; the stage keeps it transparent and out of the pointer's way
 * until then (`app/stage/CardLayer.tsx`). The shown entry is also one of the
 * window's parts F6 moves between (app/regions.ts): it takes focus whole,
 * so Tab goes on into the card from there, and while it holds focus the
 * reading keys scroll its body (`cardKeys.ts`). It names the entry it
 * draws, so a command for the shown card acts on that entry alone.
 */
export function StageEntry({
  entryId,
  role,
  ready = true,
  enabled,
  initial,
  style,
  children,
}: {
  entryId: string;
  role: StageRole;
  /** An unready shown document draws, but cannot receive a choice or focus. */
  ready?: boolean;
  /** Entrances are allowed for an entry born now (boot read, nothing on screen). */
  enabled: boolean;
  initial: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [reveal] = useState(
    () => role === "shown" && enabled && (!initial || initialSurfacePainted),
  );
  // The arrival plays when the entry first comes into sight. An unready shown
  // entry is held at inline opacity 0, which the arrival's animation would
  // override: it would fade in undrawn, vanish when the animation ends, then
  // appear again once ready (INF-709).
  const [arrived, setArrived] = useState(ready);
  if (ready && !arrived) setArrived(true);
  const [bodyDrawn, setBodyDrawn] = useState(false);
  const onDrawn = useCallback(() => setBodyDrawn(true), []);
  useEffect(() => {
    if (role === "shown") initialSurfacePainted = true;
  }, [role]);
  return (
    <StageRoleContext.Provider value={role}>
      <EntranceContext.Provider value={reveal}>
        <BodyEntranceContext.Provider value={{ reveal: reveal && !bodyDrawn, onDrawn }}>
          <div
            data-stage-entry={role}
            data-stage-entry-id={entryId}
            data-stage-reveal={reveal && arrived ? "entrance" : "static"}
            inert={role !== "shown" || !ready}
            aria-hidden={role === "shown" && ready ? undefined : true}
            data-window-region={role === "shown" ? "card" : undefined}
            tabIndex={role === "shown" ? -1 : undefined}
            onKeyDown={role === "shown" ? scrollBodyByKey : undefined}
            // Its own painting layer, so the card's peeks (`CardPeeks`) draw
            // behind the card and in front of the stage.
            style={{ isolation: "isolate", ...style }}
          >
            <StageFocusableContext.Provider value={role === "shown" && ready}>
              {children}
            </StageFocusableContext.Provider>
          </div>
        </BodyEntranceContext.Provider>
      </EntranceContext.Provider>
    </StageRoleContext.Provider>
  );
}

/** A reading key on the card itself scrolls its body; a key inside the card is its control's. */
function scrollBodyByKey(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.target !== event.currentTarget) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const body = event.currentTarget.querySelector<HTMLElement>("[data-card-body]");
  if (!body) return;
  const top = readingScrollTop(event.key, event.shiftKey, {
    top: body.scrollTop,
    height: body.clientHeight,
    scrollHeight: body.scrollHeight,
  });
  if (top === null) return;
  event.preventDefault();
  body.scrollTo({ top });
}

/** A working row already present in a boot thread is static. Later mounts,
 * including a newly shown surface, may reveal without holding busy state. */
export function useBodyEntrance() {
  return useContext(BodyEntranceContext);
}

export function useWorkingEntrance() {
  const surfaceEntrance = useContext(EntranceContext);
  const painted = useRef(false);
  useEffect(() => {
    painted.current = true;
  }, []);
  return surfaceEntrance || painted.current;
}

// Thread history may be loaded after boot or remounted on paging/resizing.
// Only messages born in this document reveal, and each does so just once.
const paintedMessages = new Set<number>();
export function useMessageEntrance(id: number, at: number) {
  const [reveal] = useState(() => at >= performance.timeOrigin && !paintedMessages.has(id));
  useEffect(() => {
    paintedMessages.add(id);
  }, [id]);
  return reveal;
}
