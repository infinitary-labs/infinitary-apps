import { describe, expect, it } from "vitest";
import { parseOption } from "../decisions/decisionModel";
import {
  type ComputerChoiceComputer,
  computerChoiceQuestions,
  computerChoiceState,
  readComputerPick,
} from "./computerChoice";

/**
 * INF-1729's computer question: the answers it offers for the computers that
 * can run a task, and what an answer starts or waits on. The captain's two
 * computers, as the Nov 14 audit read them: this MacBook and a Mac mini
 * that runs work.
 */
const macBook: ComputerChoiceComputer = {
  computerId: null,
  name: "Kun's MacBook Pro",
  here: true,
  status: "room",
  roomFor: 3,
  model: "anthropic-claude/claude-opus-5-5",
  continued: false,
};
const macMini: ComputerChoiceComputer = {
  computerId: "875ece86-3e09-4c54-a108-15fafad9b31b",
  name: "Kun’s Mac mini",
  here: false,
  status: "busy",
  model: "anthropic-claude/claude-opus-5-5",
  continued: true,
};

describe("the computer question", () => {
  it("asks where the task belongs among every computer, and what to do only when one cannot start it now", () => {
    const questions = computerChoiceQuestions([macBook, macMini]);
    expect(Object.keys(questions.computer?.criteria ?? {})).toEqual([
      "onmacbook",
      "onmini",
      "usual",
      "unsure",
    ]);
    expect(Object.keys(questions.ifNotNow?.criteria ?? {})).toEqual([
      "anyway",
      "wait",
      "other",
      "usual",
      "unsure",
    ]);
    // A person's own model answers in one word, read as letters: each option survives that read.
    for (const question of Object.values(questions)) {
      const ids = Object.keys(question.criteria);
      expect(question.abstain).toBe("unsure");
      expect(ids.map((id) => parseOption(`${id}.`, ids))).toEqual(ids);
    }
    expect(Object.keys(computerChoiceQuestions([macBook, { ...macMini, status: "room" }]))).toEqual(
      ["computer"],
    );
  });

  it("starts or waits on the computer the task belongs on, as its room and the second answer say", () => {
    const answer = (value: string, outcome: "answered" | "abstained" | "failed" = "answered") => ({
      value,
      outcome,
      version: "cc13-x",
      source: "jev/jev-1.13.0",
    });
    const away = { ...macMini, status: "away" as const };
    const pick = (computers: ComputerChoiceComputer[], where: string, notNow?: string) =>
      readComputerPick(computers, {
        computer: answer(where),
        ...(notNow ? { ifNotNow: answer(notNow) } : {}),
      });
    // Room: the first answer alone starts it.
    expect(pick([macBook, macMini], "onmacbook")).toEqual({
      computerId: null,
      mode: "start",
      source: "jev/jev-1.13.0",
    });
    // Busy: start anyway, wait, or leave another computer to the usual rules.
    expect(pick([macBook, macMini], "onmini", "anyway")).toMatchObject({
      computerId: macMini.computerId,
      mode: "start",
    });
    expect(pick([macBook, macMini], "onmini", "wait")?.mode).toBe("wait");
    expect(pick([macBook, macMini], "onmini", "other")).toBeUndefined();
    expect(pick([macBook, macMini], "onmini")).toBeUndefined();
    // Out of reach: anyway waits, since nothing can start there.
    expect(pick([macBook, away], "onmini", "anyway")).toMatchObject({
      computerId: macMini.computerId,
      mode: "wait",
    });
    expect(pick([macBook, macMini], "usual", "anyway")).toBeUndefined();
    expect(
      readComputerPick([macBook, macMini], { computer: answer("unsure", "abstained") }),
    ).toBeUndefined();
    expect(
      readComputerPick([macBook, macMini], { computer: answer("onmini", "failed") }),
    ).toBeUndefined();
    expect(pick([macBook, macMini], "onelsewhere")).toBeUndefined();
  });

  it("sends each direction whole, leaving out and counting one that does not fit", () => {
    const long = "Run it on the Mac mini. ".repeat(1_200);
    const { facts } = computerChoiceState({
      task: { title: "Fix the footer", goal: "Fix it.", delivers: "change", project: "ledger" },
      directions: ["Code changes run on the Mac mini.", long],
      computers: [macBook, macMini],
    });
    expect(facts.standing_directions).toBe("- Code changes run on the Mac mini.");
    expect(facts.directions_left_out).toBe(1);
  });
});
