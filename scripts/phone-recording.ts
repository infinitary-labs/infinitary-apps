import { copyFileSync } from "node:fs";
import { join } from "node:path";

type Recording = { name: string; raw: string };
type Run = (command: string, args: string[]) => Promise<string>;

/** INF-1066: CI keeps the simulator's H.264 capture; encoding needs no tools on the test Mac. */
export function phoneRecording(mode: "off" | "raw" | "encoded", run: Run) {
  return {
    enabled: mode !== "off",
    childArgs: mode === "raw" ? ["--raw-demo"] : mode === "encoded" ? ["--demo"] : [],
    async prepare() {
      if (mode === "encoded") await run("ffmpeg", ["-version"]);
    },
    async finish(recordings: Recording[], evidence: string) {
      if (mode === "raw") {
        for (const { name, raw } of recordings) copyFileSync(raw, join(evidence, `${name}-raw.mp4`));
        return;
      }
      if (mode !== "encoded") return;
      for (const { name, raw } of recordings) {
        const crop = name === "reconnect" || name === "reopen" ? "crop=iw:trunc(ih*0.55/2)*2:0:0," : "";
        await run("ffmpeg", ["-y", "-i", raw, "-vf", `${crop}scale=-2:720,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,tpad=stop_mode=clone:stop_duration=5`, "-r", "24", "-t", "15", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, `${name}.mp4`)]);
        await run("ffmpeg", ["-y", "-sseof", "-0.25", "-i", join(evidence, `${name}.mp4`), "-frames:v", "1", join(evidence, `${name}-poster.png`)]);
      }
    },
  };
}
