import { spawn } from "node:child_process";

/**
 * The most a bring reads from its source, all its secrets together: a
 * bound on what the core process holds in memory at once. A larger output
 * stops the source and keeps nothing.
 */
export const BRING_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/** How reading the source ended: its output, or why there is none. */
export type SourceOutput =
  | { output: Buffer }
  | { failed: { exitCode?: number; signal?: string } }
  | "changed"
  | "too-large";

/** Capture only stdout, in memory. The caller owns and wipes the returned buffer. */
export function readRunOutput(
  path: string,
  args: string[],
  options: { argv0: string; cwd: string; env: NodeJS.ProcessEnv },
  limitMs: number,
): Promise<SourceOutput> {
  return new Promise<SourceOutput>((settle) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const child = spawn(path, args, {
      ...options,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const forget = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    let done = false;
    const end = (outcome: SourceOutput) => {
      if (done) {
        if (typeof outcome === "object" && "output" in outcome) outcome.output.fill(0);
        return;
      }
      done = true;
      clearTimeout(timer);
      settle(outcome);
    };
    // A process the program left behind can hold the output open past the
    // child's own end, so the limit settles without waiting for the close.
    const stop = (outcome: SourceOutput) => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      forget();
      end(outcome);
    };
    const timer = setTimeout(() => stop({ failed: { signal: "SIGKILL" } }), limitMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (over) {
        chunk.fill(0);
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
      if (size > BRING_OUTPUT_MAX_BYTES) {
        over = true;
        stop("too-large");
      }
    });
    child.once("error", () => {
      forget();
      end({ failed: {} });
    });
    child.once("close", (code, signal) => {
      if (done) return;
      if (code !== 0) {
        forget();
        end({
          failed: code !== null ? { exitCode: code } : { signal: signal ?? "unknown" },
        });
        return;
      }
      const output = Buffer.concat(chunks);
      forget();
      end({ output });
    });
  });
}
