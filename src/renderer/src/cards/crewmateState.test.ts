import type { CrewLine, CrewTranscript } from "@shared/crewTranscript";
import type { TaskDetail } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { cardOfBlock, crewStateOf, liveWords, runningCalls } from "./crewmateState";

const detail = (over: Partial<TaskDetail> = {}): TaskDetail =>
  ({
    id: "t1",
    status: "active",
    activity: "idle",
    waitingCardId: null,
    flags: { needsYou: false },
    cards: [],
    ...over,
  }) as unknown as TaskDetail;

const tool = (id: string, answered: boolean): CrewLine => ({
  kind: "tool",
  id,
  at: 1,
  name: "Bash",
  target: "pnpm test",
  reading: "",
  result: answered ? { ref: `${id}-r`, lines: 1, preview: "ok", error: false, pictures: [] } : null,
});

describe("the Crewmate tab's state", () => {
  it("reads where the crewmate stands from the task's typed state", () => {
    expect(crewStateOf(detail({ status: "done" }), null)).toBe("closed");
    expect(crewStateOf(detail({ activity: "running" }), null)).toBe("working");
    expect(crewStateOf(detail(), { taskId: "t1", text: "", since: 5 })).toBe("working");
    expect(crewStateOf(detail({ waitingCardId: "card-1" }), null)).toBe("waiting");
    expect(crewStateOf(detail(), null)).toBe("idle");
  });

  it("shows what the crewmate is writing only until its session holds the same words", () => {
    const transcript = (said: string): CrewTranscript => ({
      taskId: "t1",
      earlier: 0,
      revision: "r",
      lines: [{ kind: "said", id: "s", at: 1, text: said }],
    });
    const live = { taskId: "t1", text: "Opening the pull request", since: 1 };
    expect(liveWords(transcript("Reading the code."), live)).toBe("Opening the pull request");
    expect(liveWords(transcript("Opening the pull request now."), live)).toBe("");
    expect(liveWords(null, { ...live, text: "  " })).toBe("");
  });

  it("reads a call with no answer as running only in the running turn, after the last line it was sent", () => {
    const lines: CrewLine[] = [
      tool("old", false),
      { kind: "sent", id: "s", at: 2, from: "captain", text: "go on", queued: false },
      tool("done", true),
      tool("now", false),
    ];
    expect([...runningCalls(lines, true)]).toEqual(["now"]);
    expect([...runningCalls(lines, false)]).toEqual([]);
  });

  it("finds the card a card block names by the id the crewmate gave it, else by its title", () => {
    const cards = [
      { id: "card-t1-merge-it", kind: "decision", title: "Merge it?", state: "open", at: 1 },
      { id: "card-t1-3", kind: "note", title: "Pictures are in", state: "closed", at: 2 },
    ] as TaskDetail["cards"];
    const block = (title: string, cardId: string | null): Extract<CrewLine, { kind: "card" }> => ({
      kind: "card",
      id: "b",
      at: 1,
      title,
      cardId,
    });
    expect(cardOfBlock(detail({ cards }), block("Merge it?", "merge-it"))?.id).toBe(
      "card-t1-merge-it",
    );
    expect(cardOfBlock(detail({ cards }), block("Pictures are in", null))?.id).toBe("card-t1-3");
    expect(cardOfBlock(detail({ cards }), block("Gone", "gone"))).toBeUndefined();
  });
});
