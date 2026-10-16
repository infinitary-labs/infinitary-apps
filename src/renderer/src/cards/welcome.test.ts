import { isPreviewBody } from "@shared/cards";
import {
  WELCOME_ANSWER,
  WELCOME_BODY,
  WELCOME_CHAPTERS,
  WELCOME_LABELS,
  WELCOME_NOTE,
  WELCOME_STARTERS,
  WELCOME_STARTERS_LEAD,
  WELCOME_TITLE,
  WELCOME_WORDS,
} from "@shared/welcome";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildPrototypeSrcdoc } from "./prototypeSrcdoc";

type Element = ReturnType<typeof DomUtils.getElementsByTagName>[number];

const words = (node: Element) => DomUtils.textContent(node).replace(/\s+/g, " ").trim();

/** The welcome as its frame's document carries it, in one theme. */
function welcome(theme: "dark" | "light", { script }: { script: boolean }) {
  const body = script ? WELCOME_BODY : WELCOME_BODY.replace(/<script>[\s\S]*?<\/script>/g, "");
  return parseDocument(buildPrototypeSrcdoc(body, theme));
}

/** Whether nothing on the element or above it in the document hides it. */
function drawn(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parent as Element | null) {
    if (node.type !== "tag") continue;
    if (node.attribs.hidden !== undefined) return false;
    if (/(visibility:\s*hidden|display:\s*none)/.test(node.attribs.style ?? "")) return false;
  }
  return true;
}

/** Independent oracle for the approved copy (FI3-1164), read off the real card document. */
describe("approved welcome document", () => {
  it.each(["dark", "light"] as const)(
    "pins its title, words, labels and starters in %s",
    (theme) => {
      const document = welcome(theme, { script: true });
      expect(WELCOME_TITLE).toBe("Welcome to Infinitary, captain. I'm your first mate.");
      expect(WELCOME_WORDS).toEqual({
        box: "Type what you want done in the message box under this card.",
        card: "I bring back answers and choices as cards like this one.",
        activity: "Crewmates do the work in the background and report here.",
        tasks: "Every ask gets a record here.",
        end: "That is all of it. To begin, press a starter below.",
      });
      expect(WELCOME_CHAPTERS).toBe(5);
      // The one paragraph outside the picture leads the starters.
      expect(DomUtils.getElementsByTagName("p", document).map(words)).toEqual([
        "To begin, press one and finish the sentence:",
      ]);
      expect(WELCOME_STARTERS_LEAD).toBe("To begin, press one and finish the sentence:");
      // Each starter is a button whose press carries its words to the message box.
      const starters = DomUtils.findAll(
        (node) => node.name === "button" && node.attribs["data-inf-draft"] !== undefined,
        document.children,
      );
      expect(starters.map((button) => [words(button), button.attribs["data-inf-draft"]])).toEqual([
        ["Clone a project", "Clone the project at "],
        ["Start a new project", "Start a new project called "],
        ["Work in a folder on my computer", "Work in the folder "],
      ]);
      expect(WELCOME_STARTERS.map((starter) => starter.label)).toEqual(
        starters.map((button) => words(button)),
      );
      // The picture's labels, and the controls under it.
      expect(DomUtils.getElementsByTagName("text", document).map(words)).toEqual([
        WELCOME_LABELS.box,
        WELCOME_LABELS.activity,
        WELCOME_LABELS.tasks,
      ]);
      expect(WELCOME_LABELS).toEqual({
        activity: "Activity",
        tasks: "Tasks",
        box: "the message box",
      });
      const steps = DomUtils.findAll(
        (node) => node.attribs["data-step"] !== undefined,
        document.children,
      );
      expect(steps.map(words)).toEqual(["Back", "Next"]);
      const figures = DomUtils.getElementsByTagName("figure", document);
      expect(figures).toHaveLength(1);
      expect(figures[0]?.attribs["aria-label"]).toBeTruthy();
      // The closing line waits on the words beside the box for the last chapter.
      const said = DomUtils.findOne(
        (node) => node.attribs["data-part"] === "words",
        document.children,
      );
      expect(said?.attribs["data-last"]).toBe(WELCOME_WORDS.end);
    },
  );

  it("reads whole with its script removed: every part and its words, and nothing pressable that does nothing", () => {
    const document = welcome("dark", { script: false });
    const parts = DomUtils.findAll(
      (node) => node.attribs["data-part"] !== undefined,
      document.children,
    );
    const shown = parts.filter(drawn).map((node) => node.attribs["data-part"]);
    // The card covers the Firstmate, as the window shows it: every other part is drawn.
    expect(shown).toEqual(["box", "words", "card", "activity", "tasks"]);
    const text = parts.filter(drawn).map(words).join(" ");
    for (const said of [
      WELCOME_WORDS.box,
      WELCOME_WORDS.card,
      WELCOME_WORDS.activity,
      WELCOME_WORDS.tasks,
    ])
      expect(text).toContain(said);
    // Back and Next only move the script's chapters: without it they are not drawn.
    const steps = DomUtils.findAll(
      (node) => node.attribs["data-step"] !== undefined,
      document.children,
    );
    expect(steps.length).toBe(2);
    expect(steps.some(drawn)).toBe(false);
    // The starters are the frame bridge's, not the script's: they stay.
    const starters = DomUtils.findAll(
      (node) => node.attribs["data-inf-draft"] !== undefined,
      document.children,
    );
    expect(starters.filter(drawn)).toHaveLength(3);
  });

  it("keeps the welcome in words for its record and the Firstmate, without its picture or script", () => {
    expect(WELCOME_NOTE).toEqual({
      title: WELCOME_TITLE,
      body: WELCOME_BODY,
      answer: WELCOME_ANSWER,
    });
    const record = parseDocument(WELCOME_ANSWER);
    expect(DomUtils.getElementsByTagName("li", record).map(words)).toEqual([
      `The message box: ${WELCOME_WORDS.box}`,
      `A card: ${WELCOME_WORDS.card}`,
      `Activity, on the left: ${WELCOME_WORDS.activity}`,
      `Tasks, on the right: ${WELCOME_WORDS.tasks}`,
    ]);
    for (const starter of WELCOME_STARTERS) expect(WELCOME_ANSWER).toContain(starter.label);
    expect(WELCOME_ANSWER).not.toMatch(/<(svg|script|button)/);
  });

  it("stays prose: its one script moves its figure, and it brings no style sheet", () => {
    expect(isPreviewBody(WELCOME_BODY)).toBe(false);
    expect(WELCOME_BODY.match(/<script>/g)).toHaveLength(1);
    expect(WELCOME_BODY).not.toMatch(/<style/);
  });
});
