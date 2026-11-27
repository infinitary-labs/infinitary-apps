import { describe, expect, it } from "vitest";
import { DROP_REVIEW_STALE, dropQuestionOf, dropRefusalOf } from "./recordDrop";
import type { DropEffects } from "./tasks";

const effects: DropEffects = {
  parts: [
    { key: "FI3-13", title: "Sound the channel", started: false },
    { key: "FI3-14", title: "Mark the reef", started: true },
  ],
  waiting: [{ key: "FI3-20", title: "Light the buoys" }],
  underway: [
    { key: "FI3-21", title: "Count the buoys" },
    { key: "FI3-22", title: "Ring the bell" },
  ],
};
const none: DropEffects = { parts: [], waiting: [], underway: [] };

describe("Drop task's first press on the record", () => {
  it("refuses never-started work whose record lists no effects", () => {
    expect(dropRefusalOf("drop-task", null)).toBe(DROP_REVIEW_STALE);
    expect(dropRefusalOf("drop-task", undefined)).toBe(DROP_REVIEW_STALE);
  });

  it("asks when the record lists the effects, even when they are empty", () => {
    expect(dropRefusalOf("drop-task", effects)).toBeNull();
    expect(dropRefusalOf("drop-task", none)).toBeNull();
  });

  it("never refuses stopping started work, which reviews no effects", () => {
    expect(dropRefusalOf("stop-task", null)).toBeNull();
  });
});

describe("Drop task's question on the record", () => {
  it("names what happens to the parts, the waiting tasks and the working ones, in that order", () => {
    expect(dropQuestionOf("FI3-12", "drop-task", effects)).toBe(
      "Drop FI3-12? It won't start, and there is no unfinished work to keep. Its record stays." +
        " Its part FI3-13 stays planned. Its part FI3-14 has started and keeps working." +
        " FI3-20 is still waiting on this work. Dropping this task will not start it." +
        " 2 tasks are already working (FI3-21, FI3-22) and will not be stopped.",
    );
  });

  it("asks with the lead alone when nothing else is affected", () => {
    expect(dropQuestionOf("FI3-12", "drop-task", none)).toBe(
      "Drop FI3-12? It won't start, and there is no unfinished work to keep. Its record stays.",
    );
  });

  it("says a copy of unfinished work is kept on started work, and names no effects there", () => {
    expect(dropQuestionOf("FI3-12", "stop-task", effects)).toBe(
      "Drop FI3-12? It ends the task and keeps a copy of its unfinished work.",
    );
  });
});
