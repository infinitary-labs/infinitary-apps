/**
 * The messages between the core's runner (./programRunner.ts) and the
 * program process (./programProcess.ts), docs/programs.md "The runner".
 * A script reaches the app only through `call`: each host function it
 * names - task(), ask(), log(), phase() - is one call, answered by the
 * runner with a value or an error the script's await throws.
 */

/** The host functions a script has in scope, each one call to the runner. */
export type ProgramOp = "task" | "ask" | "log" | "phase";

/** The core to the program process: run once, then an answer per call. */
export type ProgramParentMessage =
  | { type: "run"; script: string; args: unknown }
  | { type: "answer"; id: number; value: unknown }
  | { type: "refuse"; id: number; message: string };

/** The program process to the core. */
export type ProgramChildMessage =
  | { type: "call"; id: number; op: ProgramOp; input: unknown[] }
  | { type: "done"; value: unknown }
  | { type: "failed"; message: string };
