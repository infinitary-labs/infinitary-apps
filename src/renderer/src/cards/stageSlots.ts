/**
 * Which stack entries the stage keeps mounted, and as what (FI3-596's
 * approved rendering; docs/renderer.md, "Replacement presentation"):
 *
 * - `shown`: the selected entry, in flow. It appears once it is ready.
 * - `outgoing`: the drawing the captain was looking at, kept inert while the
 *   shown entry gets ready and through the crossfade, then retired.
 * - `warm`: the entry a close would bring up (`dismissalSuccessor`),
 *   prepared invisibly while the captain reads and promoted in place.
 *
 * At most two documents: an outgoing drawing and a prepared successor never
 * coexist, so the next successor is prepared only once the outgoing drawing
 * is gone. The stage also waits until the incoming reveal and the height
 * easing have finished (`HomeScreen`) before it asks for that successor. Every slot has a key of its own and keeps its birth order, so
 * React never moves a frame that is already in the DOM (moving an iframe
 * reloads its document). Only a prepared successor is promoted with its
 * document. Any other selection mounts afresh, even of an entry whose
 * drawing is still fading out, so nothing a card held on screen outlives
 * its leaving (the existing preview lifetime: paging back starts a card
 * anew); only a drawing nothing has replaced on screen yet is shown again
 * as it is.
 * Pure: the stage calls it on every render and keeps what it returns.
 */

export type SlotRole = "shown" | "warm" | "outgoing";

/** One mounted entry: the stack entry's id and the key its mount is born under. */
export type Slot = { id: string; key: string };

export type StageSlots<V> = {
  /** The selected entry. */
  shown: Slot | null;
  /** The shown entry is on screen: it was ready, or its hold expired. */
  revealed: boolean;
  /** The retained drawing, and the view it was last shown with. */
  outgoing: (Slot & { view: V }) | null;
  /** The prepared successor. */
  warm: Slot | null;
  /** Birth order of every mounted slot, by key. */
  order: Readonly<Record<string, number>>;
  next: number;
};

export function emptySlots<V>(): StageSlots<V> {
  return { shown: null, revealed: false, outgoing: null, warm: null, order: {}, next: 0 };
}

/**
 * The slots for this render: `shown` is the selected entry's id, `warm`
 * the successor the stage would prepare (already filtered for what may be
 * prepared), `lastView` the view the previously shown entry was drawn with.
 * Returns the same object when nothing changed.
 *
 * A new selection keeps on screen whatever the captain can see: the
 * previous entry when it had appeared, else the drawing already held. An
 * entry that never appeared is dropped, so rapid paging never queues. With
 * nothing on screen to hold, the new entry appears at once.
 */
export function selectSlots<V>(
  state: StageSlots<V>,
  shown: string | null,
  warm: string | null,
  lastView: V | undefined,
): StageSlots<V> {
  let next: StageSlots<V> = state;
  if (shown !== (state.shown?.id ?? null)) {
    if (!state.revealed && state.outgoing?.id === shown) {
      // Back to the drawing still held, before anything replaced it on
      // screen: it is shown again as it is.
      const { view: _view, ...held } = state.outgoing;
      next = { ...state, shown: held, outgoing: null, revealed: true };
    } else {
      next = select(state, shown, lastView);
    }
  }
  const prepared = next.outgoing === null && warm !== null && warm !== shown ? warm : null;
  if (prepared !== (next.warm?.id ?? null)) {
    next =
      prepared === null
        ? { ...next, warm: null }
        : { ...next, warm: { id: prepared, key: `${prepared}#${next.next}` }, next: next.next + 1 };
  }
  return withOrder(next);
}

/** A new selection, holding whatever the captain sees now. */
function select<V>(
  state: StageSlots<V>,
  shown: string | null,
  lastView: V | undefined,
): StageSlots<V> {
  const previous = state.shown;
  const outgoing =
    state.revealed && previous !== null && lastView !== undefined
      ? { ...previous, view: lastView }
      : state.outgoing;
  let born = state.next;
  // The prepared successor keeps its document; anything else is born now,
  // even an entry whose own drawing is still fading out.
  const selected =
    shown === null
      ? null
      : state.warm?.id === shown
        ? state.warm
        : { id: shown, key: `${shown}#${born++}` };
  return {
    ...state,
    shown: selected,
    outgoing,
    revealed: outgoing === null,
    warm: state.warm?.id === shown ? null : state.warm,
    next: born,
  };
}

/** The shown entry is ready: it appears, and the outgoing drawing starts to leave. */
export function revealSlot<V>(state: StageSlots<V>, key: string): StageSlots<V> {
  if (state.shown?.key !== key || state.revealed) return state;
  return { ...state, revealed: true };
}

/** The outgoing drawing has faded out: it leaves the stage. */
export function retireSlot<V>(state: StageSlots<V>, key: string): StageSlots<V> {
  if (state.outgoing?.key !== key) return state;
  return withOrder({ ...state, outgoing: null });
}

/**
 * The shown entry never became ready inside its hold: it appears as it is,
 * and the drawing it replaces leaves at once. Never counted as ready.
 */
export function expireSlot<V>(state: StageSlots<V>, key: string): StageSlots<V> {
  if (state.shown?.key !== key || state.revealed) return state;
  return withOrder({ ...state, revealed: true, outgoing: null });
}

/** The mounted slots in birth order, each with its role. */
export function slotRoles<V>(state: StageSlots<V>): (Slot & { role: SlotRole })[] {
  const roles: (Slot & { role: SlotRole })[] = [];
  if (state.outgoing)
    roles.push({ id: state.outgoing.id, key: state.outgoing.key, role: "outgoing" });
  if (state.shown) roles.push({ ...state.shown, role: "shown" });
  if (state.warm) roles.push({ ...state.warm, role: "warm" });
  return roles.sort((a, b) => (state.order[a.key] ?? 0) - (state.order[b.key] ?? 0));
}

/** Keeps birth order for the mounted keys only; a new key is born last. */
function withOrder<V>(state: StageSlots<V>): StageSlots<V> {
  const keys = [state.outgoing?.key, state.shown?.key, state.warm?.key].filter(
    (key): key is string => key !== undefined,
  );
  const known = Object.keys(state.order);
  const same = known.length === keys.length && keys.every((key) => state.order[key] !== undefined);
  if (same) return state;
  let next = state.next;
  const order: Record<string, number> = {};
  for (const key of keys) order[key] = state.order[key] ?? next++;
  return { ...state, order, next };
}
