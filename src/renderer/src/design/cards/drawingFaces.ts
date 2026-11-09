/**
 * The app's own copies of the card's typefaces, by file name: a diagram the
 * viewer shows names the faces the card drew it with (`withDrawingFaces`,
 * INF-3107), and a picture loads nothing, so each face goes inside it as the
 * file itself. They are the very files the app's stylesheet loads.
 */
const FACE_URLS = import.meta.glob<string>("../assets/fonts/*.woff2", {
  eager: true,
  query: "?url",
  import: "default",
});

const read = new Map<string, Promise<string | undefined>>();

/** One face's file as a `data:` URL, read once; `undefined` for a file the app does not ship. */
export function cardFace(file: string): Promise<string | undefined> {
  const url = FACE_URLS[`../assets/fonts/${file}`];
  if (!url) return Promise.resolve(undefined);
  let face = read.get(file);
  if (!face) {
    face = fetch(url)
      .then((response) => (response.ok ? response.blob() : undefined))
      .then((blob) => (blob ? dataUrlOf(new Blob([blob], { type: "font/woff2" })) : undefined))
      .catch(() => undefined);
    read.set(file, face);
  }
  return face;
}

function dataUrlOf(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}
