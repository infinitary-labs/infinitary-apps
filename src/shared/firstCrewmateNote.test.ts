import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { isPreviewBody } from "./cards";
import { FIRST_CREWMATE_BODY } from "./firstCrewmateNote";

type Element = ReturnType<typeof DomUtils.getElementsByTagName>[number];

const marked = (name: string) => (node: Element) => node.attribs[name] !== undefined;

// INF-5609's approved plan: the note draws the live stage through the app's
// stage part, and a reader that does not ship the part - an older phone or
// view - keeps today's still crewmate and no empty stage.
describe("the first crewmate's note", () => {
  it("stays a note: the stage's part reference sits inside its figure", () => {
    expect(isPreviewBody(FIRST_CREWMATE_BODY)).toBe(false);
  });

  it("shows the still crewmate and no stage to a reader without the part", () => {
    const document = parseDocument(FIRST_CREWMATE_BODY);
    const [stage, ...others] = DomUtils.findAll(marked("data-inf-stage"), document.children);
    expect(stage?.name).toBe("figure");
    expect(stage?.attribs["data-inf-stage"]).toBe("sendoff");
    expect(stage?.attribs.hidden).toBeDefined();
    // The Now panel's live crewmate is an empty mark over the still one.
    expect(others.map((node) => node.attribs["data-inf-stage"])).toEqual(["crewmate"]);
    expect(DomUtils.textContent(others[0] as Element)).toBe("");
    const stills = DomUtils.findAll(marked("data-inf-stage-still"), document.children);
    expect(stills.map((node) => node.name)).toEqual(["svg"]);
    expect(DomUtils.findAll((node) => node.name === "path", stills)).toHaveLength(2);
  });
});
