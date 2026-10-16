import { readFile } from "node:fs/promises";
import type { ServerContext, StoreValue } from "@infinitary/contracts";
import { localDay, practiceOf, readRecord } from "./record";

// The teacher fills this ONE line with the absolute subject record path.
const RECORD = "/absolute/workspace/lessons/chess/record.json";

export const background = {
  lesson: {
    everyMs: 60_000,
    async run({ db, log }: ServerContext) {
      try {
        const record = readRecord(JSON.parse(await readFile(RECORD, "utf8")));
        const snapshot = record.sittings.length ? { record, practice: practiceOf(record, localDay()) } : null;
        if (JSON.stringify(db.get("lesson")) !== JSON.stringify(snapshot))
          db.set("lesson", snapshot as StoreValue);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          db.set("lesson", null);
        } else {
          log(`Lesson record could not be read: ${String(error)}`);
          db.set("lesson", { error: "Progress could not be read. Ask your teacher to check it." });
        }
      }
    },
  },
};
