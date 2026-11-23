import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { labelChanged, labelEnter, labelGone, labelLeave, labelTakenBy } from "./iconLabel";

/**
 * The words the app draws for what the pointer or the keyboard rests on
 * (./iconLabel; design skill readme, "Facts shown on rest"): an icon button's name,
 * or a fact the element only hints at - a mark's meaning, a reset time, an
 * exact time, a chip's reason, words cut short. The pointer's rest and the
 * keyboard's focus show the same label, so neither has a fact the other
 * lacks; the label is decoration, so the element's accessible name or
 * description carries the same words for assistive technology.
 */
export type RestLabelProps = {
  ref: (node: HTMLElement | null) => void;
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
};

export type RestLabelOptions = {
  /** The command's key, drawn after the words (an icon button's). */
  keys?: string | undefined;
  /**
   * A fact's label is what a person came for: Esc while it shows lets it go
   * and nothing else, as a summary's Esc does; with nothing showing, Esc
   * means what it always meant. An icon button's label leaves Esc alone.
   */
  fact?: boolean;
};

/**
 * The handlers that show `words` (and a command's `keys`) in the app's
 * label on rest: a mouse resting on the element, or the keyboard's focus on
 * it. With no words nothing shows. A label on screen follows the words as
 * they change, and an element that leaves the page takes its label along.
 */
export function useRestLabel(
  words: string | undefined,
  { keys, fact = false }: RestLabelOptions = {},
): RestLabelProps {
  const own = useRef<HTMLElement | null>(null);
  const current = useRef({ words, keys });
  current.current = { words, keys };
  useEffect(() => {
    if (!own.current) return;
    if (words) labelChanged(own.current, words, keys);
    else labelGone(own.current);
  }, [words, keys]);
  // The element the hook last held keeps its place in `own` (a null from
  // React is not kept), so the unmount takes the label with it, also when no
  // pointer or key reached the page first (a window command closed what it
  // was in).
  useEffect(
    () => () => {
      if (own.current) labelGone(own.current);
    },
    [],
  );
  const ref = useCallback((node: HTMLElement | null) => {
    const held = own.current;
    if (node === null) {
      // A new ref passes null before the same node again; only an element
      // that really left the page takes its label along.
      if (held) queueMicrotask(() => !held.isConnected && labelGone(held));
      return;
    }
    if (held && held !== node) labelGone(held);
    own.current = node;
  }, []);
  const enter = (element: HTMLElement) => {
    const { words: text, keys: key } = current.current;
    if (text) labelEnter(element, text, key);
  };
  return {
    ref,
    onPointerEnter: (event) => {
      if (event.pointerType === "mouse") enter(event.currentTarget);
    },
    onPointerLeave: (event) => labelLeave(event.currentTarget),
    // The keyboard rests on an element as the pointer does (docs/keyboard.md,
    // "Seeing where focus is"); a click's focus shows no label of its own.
    onFocus: (event) => {
      if (event.currentTarget.matches(":focus-visible")) enter(event.currentTarget);
    },
    onBlur: (event) => labelLeave(event.currentTarget),
    onKeyDown: (event) => {
      if (fact && event.key === "Escape" && labelTakenBy(event.currentTarget, event.nativeEvent))
        event.stopPropagation();
    },
  };
}

export type OwnRestHandlers<T extends HTMLElement> = {
  ref?: React.Ref<T> | undefined;
  onPointerEnter?: React.PointerEventHandler<T> | undefined;
  onPointerLeave?: React.PointerEventHandler<T> | undefined;
  onFocus?: React.FocusEventHandler<T> | undefined;
  onBlur?: React.FocusEventHandler<T> | undefined;
  onKeyDown?: React.KeyboardEventHandler<T> | undefined;
};

/**
 * `useRestLabel` for an element that has a ref and handlers of its own (a
 * button's, ./Button and ./IconButton): one ref that reaches both, and each
 * handler running the label's first, then the element's own.
 */
export function useRestLabelWith<T extends HTMLElement>(
  words: string | undefined,
  options: RestLabelOptions,
  own: OwnRestHandlers<T>,
): Required<{ [K in keyof OwnRestHandlers<T>]: NonNullable<OwnRestHandlers<T>[K]> }> & {
  ref: (node: T | null) => void;
} {
  const rest = useRestLabel(words, options);
  const restRef = rest.ref;
  const { ref } = own;
  const setRef = useCallback(
    (node: T | null) => {
      restRef(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, restRef],
  );
  return {
    ref: setRef,
    onPointerEnter: (event) => {
      rest.onPointerEnter(event);
      own.onPointerEnter?.(event);
    },
    onPointerLeave: (event) => {
      rest.onPointerLeave(event);
      own.onPointerLeave?.(event);
    },
    onFocus: (event) => {
      rest.onFocus(event);
      own.onFocus?.(event);
    },
    onBlur: (event) => {
      rest.onBlur(event);
      own.onBlur?.(event);
    },
    onKeyDown: (event) => {
      rest.onKeyDown(event);
      own.onKeyDown?.(event);
    },
  };
}
