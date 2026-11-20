import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratchDirs";

/**
 * A stand-in for the voice helper and its 1.6 GB model (src/main/voice/voiceHelperEntry.ts),
 * which every launch forks as its voice helper (INFINITARY_VOICE_HELPER_ENTRY,
 * a development run only) unless a check asks for the app's own
 * (`useAppVoiceHelper`). It speaks the helper's messages
 * (@shared/voiceRecognizer). Every recording still travels from the window
 * through the main process to a helper process; this one answers `text`
 * for any recording that arrived as PCM, and refuses one that did not.
 * Asked what its speech library can do, it lists WebGPU, as the library's
 * builds for Apple silicon and Linux x64 do, so speech runs in the helper on
 * every computer the suite runs on. Returns the entry's path.
 */
export function writeVoiceHelperStandIn(text: string): string {
  const entry = join(scratchDir("infinitary-voice-helper-"), "voiceHelperStandIn.mjs");
  writeFileSync(
    entry,
    `const text = ${JSON.stringify(text)};
const port = process.parentPort;
port.on("message", ({ data }) => {
  if (data.type === "ability") {
    port.postMessage({ id: data.id, type: "ability", providers: ["cpu", "webgpu"] });
  } else if (data.type === "init") {
    port.postMessage({ id: data.id, type: "ready" });
  } else if (data.audio instanceof Float32Array && data.audio.length > 0) {
    port.postMessage({ id: data.id, type: "result", text });
  } else {
    port.postMessage({ id: data.id, type: "error", message: "No recording arrived." });
  }
});
`,
  );
  return entry;
}
