import { describe, expect, it } from "vitest";
import { briefText } from "../orchestrator/intentBrief";
import { compactBrief, expandBrief } from "./briefReceipt";

/**
 * The receipt's references (`./briefReceipt.ts`): a report copied into a
 * brief is stored as a reference only where that is smaller, and reading
 * the receipt back puts the served text together again.
 */
describe("a brief receipt by reference", () => {
  const long = `The agreed spec. ${"A clause kept word for word. ".repeat(20)}`;
  const parts = [
    "Goal: build it\n\nIts report - the final answer it recorded:\n",
    { taskId: "plan", eventId: 7, text: long },
    "\n\nReport event 3:\n",
    { taskId: "plan", eventId: 3, text: "Draft." },
    "\n\nBuild on it.",
  ];
  const reports = new Map([[7, long]]);

  it("references a long report, copies a short one, and reads back as served", () => {
    const { text, refs } = compactBrief(parts);
    expect(refs.map((ref) => ref.event)).toEqual([7]);
    expect(text).not.toContain("A clause kept word for word.");
    expect(text).toContain("Report event 3:\nDraft.");
    expect(text.length + JSON.stringify({ reports: refs }).length).toBeLessThan(
      briefText(parts).length,
    );
    expect(expandBrief(text, { reports: refs }, (ref) => reports.get(ref.event))).toBe(
      briefText(parts),
    );
  });

  it("leaves a stand-in naming the report when it is no longer on the record", () => {
    const { text, refs } = compactBrief(parts);
    const read = expandBrief(text, { reports: refs }, () => undefined);
    expect(read).toBe(text);
    expect(read).toContain("[report event 7 of task plan, kept on the record by reference]");
  });

  it("reads a receipt stored whole, before references, as it was stored", () => {
    const whole = briefText(parts);
    expect(expandBrief(whole, null, () => "never asked")).toBe(whole);
  });
});
