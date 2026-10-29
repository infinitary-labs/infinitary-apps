import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import type { MockProviderServer } from "./mockProvider";
import { runDir } from "./runEvidence";

/** INF-909: diagnostics survive fixture cleanup inside the existing failure upload. */
export function launchDiagnostics(
  userDataDir: string,
  provider?: MockProviderServer,
  root = join(runDir(), "launches"),
) {
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${process.pid}-${randomUUID()}`);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "launch.json"),
    JSON.stringify({ userDataDir, worker: process.env.TEST_WORKER_INDEX }),
  );
  for (const file of ["main.stdout.log", "main.stderr.log", "provider.requests.jsonl"]) {
    writeFileSync(join(dir, file), "");
  }
  let sequence = 0;
  const stopRecording = provider?.recordRequests((body) => {
    appendFileSync(
      join(dir, "provider.requests.jsonl"),
      `${JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), body: JSON.parse(body) })}\n`,
    );
  });
  return {
    dir,
    watch(child: Pick<ChildProcess, "stdout" | "stderr">) {
      child.stdout?.on("data", (chunk: Buffer) =>
        appendFileSync(join(dir, "main.stdout.log"), chunk),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        appendFileSync(join(dir, "main.stderr.log"), chunk),
      );
    },
    snapshot() {
      // Only app-owned session diagnostics, never accounts, auth stores, or a whole HOME.
      const crew = join(userDataDir, "crewmates");
      if (!existsSync(crew)) return;
      for (const task of readdirSync(crew, { withFileTypes: true })) {
        if (!task.isDirectory()) continue;
        const sessions = join(crew, task.name, "sessions");
        if (!existsSync(sessions)) continue;
        const target = join(dir, "crewmates", task.name, "sessions");
        mkdirSync(target, { recursive: true });
        try {
          // A link (a staged skill) points into the disposable scratch; copied, it
          // would dangle once that is removed, and packaging stats every file.
          cpSync(sessions, target, {
            recursive: true,
            filter: (source) => !lstatSync(source).isSymbolicLink(),
          });
        } catch (error) {
          // Diagnostics must not replace the assertion or prevent app cleanup.
          appendFileSync(join(dir, "collection-errors.log"), `${task.name}: ${String(error)}\n`);
        }
      }
    },
    stop() {
      stopRecording?.();
    },
  };
}

/** INF-1555 F16: Electron's context is not the runner's default traced browser context. */
export async function recordAppTrace(
  context: BrowserContext,
  path: string,
): Promise<() => Promise<void>> {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  return () => context.tracing.stop({ path });
}
