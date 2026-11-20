// The frame realm lib's pins, baked into the main bundle by
// scripts/frame-lib.ts (src/main/frames/frameLibFiles.ts reads them).
declare module "virtual:fm-frame-lib" {
  export const FRAME_LIB_PINS: Readonly<Record<string, string>>;
}
