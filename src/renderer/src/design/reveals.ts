import { useLayoutEffect, useRef } from "react";

/** An initially open region is a snapshot. Later opens reveal; close unmounts. */
export function useInPlaceReveal(open: boolean) {
  const previous = useRef(open);
  const reveal = useRef(false);
  if (open !== previous.current) reveal.current = open;
  useLayoutEffect(() => {
    previous.current = open;
  }, [open]);
  return open && reveal.current;
}

let shellPainted = false;
export function markShellPainted() {
  shellPainted = true;
}
export function hasShellPainted() {
  return shellPainted;
}
