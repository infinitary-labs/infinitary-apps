/**
 * INF-5608's approved plan: a window viewing a home that does not list the
 * `choice-attachments` change keeps today's hold, since that home refuses a
 * press that carries the field's notes, files or pictures.
 */

import { CHOICE_ATTACHMENTS, homeTakesChoiceAttachments } from "@shared/choiceCarried";
import { describe, expect, it } from "vitest";
import { CONTRACT_CHANGES } from "./contractChanges";

describe("whether a press may carry the field to its home", () => {
  const current = CONTRACT_CHANGES.names;
  const older = current.filter((name) => name !== CHOICE_ATTACHMENTS);

  it("lets the home itself and a view of a current home carry it", () => {
    expect(current).toContain(CHOICE_ATTACHMENTS);
    expect(homeTakesChoiceAttachments(false, null)).toBe(true);
    expect(homeTakesChoiceAttachments(true, current)).toBe(true);
  });

  it("holds a view of an older home, and one whose home has not answered yet", () => {
    expect(homeTakesChoiceAttachments(true, older)).toBe(false);
    expect(homeTakesChoiceAttachments(true, null)).toBe(false);
  });
});
