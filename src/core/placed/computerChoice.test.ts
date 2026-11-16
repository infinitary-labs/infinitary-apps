import { describe, expect, it } from "vitest";
import { parseOption } from "../decisions/decisionModel";
import {
  type ComputerChoiceComputer,
  computerChoiceQuestion,
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
  it("offers a start on each computer, a wait only where there is something to wait for, usual and unsure", () => {
    const question = computerChoiceQuestion([macBook, macMini]);
    expect(Object.keys(question.criteria)).toEqual([
      "startmacbook",
      "startmini",
      "waitmini",
      "usual",
      "unsure",
    ]);
    expect(question.abstain).toBe("unsure");
    // A person's own model answers in one word, read as letters: each option survives that read.
    const ids = Object.keys(question.criteria);
    expect(ids.map((id) => parseOption(`${id}.`, ids))).toEqual(ids);
    const away = computerChoiceQuestion([macBook, { ...macMini, status: "away" }]);
    expect(Object.keys(away.criteria)).toEqual(["startmacbook", "waitmini", "usual", "unsure"]);
  });

  it("reads an answer back to the computer it names, and nothing from usual, unsure or a failure", () => {
    const computers = [macBook, macMini];
    const answer = (value: string, outcome: "answered" | "abstained" | "failed" = "answered") => ({
      value,
      outcome,
      version: "cc1-x",
      source: "jev/jev-1.13.0",
    });
    expect(readComputerPick(computers, answer("waitmini"))).toEqual({
      computerId: macMini.computerId,
      mode: "wait",
      source: "jev/jev-1.13.0",
    });
    expect(readComputerPick(computers, answer("startmacbook"))?.computerId).toBeNull();
    expect(readComputerPick(computers, answer("usual"))).toBeUndefined();
    expect(readComputerPick(computers, answer("unsure", "abstained"))).toBeUndefined();
    expect(readComputerPick(computers, answer("unsure", "failed"))).toBeUndefined();
    expect(readComputerPick(computers, answer("startelsewhere"))).toBeUndefined();
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
