/**
 * What `sharp` resolves to in the main build (electron.vite.config.ts).
 * transformers.js imports it for image work and refuses to load without
 * one; the voice helper transcribes audio only, so no image library ships
 * and this one refuses every image.
 */
export default function noSharp(): never {
  throw new Error("The voice helper does no image work.");
}
