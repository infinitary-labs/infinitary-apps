/**
 * A file dropped anywhere that is not an input never navigates the window or
 * opens in it: the page ignores it. An input's own handlers have already
 * taken the drop by the time it reaches the window.
 */
export function guardStrayFileDrops(target: Window = window): () => void {
  const ignore = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  target.addEventListener("dragover", ignore);
  target.addEventListener("drop", ignore);
  return () => {
    target.removeEventListener("dragover", ignore);
    target.removeEventListener("drop", ignore);
  };
}
