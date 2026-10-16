import type { SqlAnswer } from "@shared/personal/contracts";
import type { SqlRequest } from "@shared/sql";

/** The core to the query process: open once, then one query at a time. */
export type SqlParentMessage =
  | { type: "open"; path: string }
  | { type: "query"; id: number; request: SqlRequest };

/** The query process to the core. */
export type SqlChildMessage =
  | { type: "ready" }
  | { type: "failed"; message: string }
  | { type: "answer"; id: number; answer: SqlAnswer }
  | { type: "error"; id: number; message: string };
