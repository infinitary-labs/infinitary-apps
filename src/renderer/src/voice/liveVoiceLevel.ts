/**
 * Live microphone RMS, written from the voiceController rAF and read from
 * the Firstmate / waveform canvas loops. Kept off the React store so a
 * recording session does not reconcile the shell on every sample.
 *
 * `null` means no capture is running; canvases then fall back to their
 * `level` prop (the design-system default / an explicit override).
 */
let liveVoiceLevel: number | null = null;

export function setLiveVoiceLevel(level: number): void {
  liveVoiceLevel = level;
}

export function clearLiveVoiceLevel(): void {
  liveVoiceLevel = null;
}

export function readLiveVoiceLevel(fallback = 0): number {
  return liveVoiceLevel ?? fallback;
}
