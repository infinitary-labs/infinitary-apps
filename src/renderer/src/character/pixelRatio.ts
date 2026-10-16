// The one place the character rig hears that the pixel ratio changed: the
// size control's zoom (src/main/windowSize.ts) or a move to a display of
// another density. A canvas's backing is fitted to the ratio, so a loop
// refits on its next frame; a reduced-motion still has no next frame, so the
// Firstmate (../Firstmate.tsx) and its crew (./crew/CrewOrbit.tsx) each
// redraw their last frame at the new ratio when this fires.

/** Called on every change of `window.devicePixelRatio`. Returns the unsubscribe. */
export function onPixelRatioChange(listener: () => void): () => void {
  let query: MediaQueryList | null = null;
  const onChange = () => {
    watch();
    listener();
  };
  // A resolution query matches one ratio only, so each change re-arms it.
  const watch = () => {
    query?.removeEventListener("change", onChange);
    query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener("change", onChange);
  };
  watch();
  return () => query?.removeEventListener("change", onChange);
}
