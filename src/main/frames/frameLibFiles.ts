/// <reference types="electron-vite/node" />
import { FRAME_LIB_PINS } from "virtual:fm-frame-lib";

/**
 * The frame realm's lib as this build made it (scripts/frame-lib.ts): every
 * file's pin, baked into the main bundle when the lib was built. The files
 * themselves are in `out/frame-lib/`, beside this bundle's own directory;
 * the shell serves one only while its bytes still match its pin
 * (frameProtocol.ts).
 *
 * Build-time only, and a leaf: the virtual module exists only inside the
 * main build, so nothing unit-tested imports this module (fontFiles.ts is
 * the precedent).
 */
export const frameLibPins = FRAME_LIB_PINS;
