import type { MicAccess } from "@shared/voice";

/**
 * What the line under the input says about microphone access
 * (docs/composer.md, "Voice"): macOS is asking, access is off, or the
 * Mac's administrator decides.
 */
export type MicLine = "asking" | "off" | "managed";

/** The line an answer leaves up: none once macOS allows, or has yet to ask. */
export function settledMicLine(access: MicAccess): Exclude<MicLine, "asking"> | null {
  if (access === "denied") return "off";
  if (access === "restricted") return "managed";
  return null;
}

/** macOS's answer, read without asking; `unknown` when the read fails. */
export async function readMicAccess(): Promise<MicAccess> {
  try {
    return (await window.infinitary.voice.micAccess()).access;
  } catch {
    return "unknown";
  }
}
