import { createHash } from "node:crypto";
import { fileSizeWords } from "@shared/attachments";
import { cardLogUrl, logSources } from "@shared/cardPictures";
import { cardSizeRefusal, cardWindowLength } from "@shared/cardSize";
import { servedNumber } from "@shared/i18n/format";
import type { LiveValidationSummary } from "@shared/liveValidationSummary";
import { FRAME_TEMPLATE_MAX_BYTES } from "@shared/plugins/frameDocument";
import { describe, expect, it } from "vitest";
import { presentationHtmlText as html } from "./presentationText";
import { validationCard } from "./presentationValidation";

/**
 * INF-3887 (captain: "prevent cards from being too large in the first
 * place"): a merge card whose live validation pasted 37 proof transcripts was
 * 1,383,135 characters long and could not open. These rows have that card's
 * shape: 17 scenarios naming 21 distinct transcripts 37 times.
 */
const TASK = "3f6c2a91";
const TRANSCRIPT_CHARS = Math.floor(645_371 / 21);

function transcript(n: number) {
  const readings = Array.from({ length: 700 }, (_, index) =>
    JSON.stringify({ run: n + 1, sample: index + 1, result: "matched expected pressure" }),
  ).join("\n");
  const text = readings.slice(0, TRANSCRIPT_CHARS);
  const digest = createHash("sha256").update(text).digest("hex");
  return {
    id: `t${n}`,
    description: `Run ${n + 1} transcript`,
    digest,
    bytes: Buffer.byteLength(text),
    file: `${TASK}-${digest}.json`,
    text,
  };
}

const transcripts = Array.from({ length: 21 }, (_, n) => transcript(n));
// 37 references over 17 rows, one transcript named nine times, as INF-3771's card did.
const references = [
  ...Array.from({ length: 9 }, () => 0),
  ...Array.from({ length: 28 }, (_, n) => 1 + (n % 20)),
];
const summary: LiveValidationSummary = {
  label: "Validated live",
  reason: "Every required scenario passed live on this version.",
  revision: 1,
  live: 17,
  total: 17,
  rows: Array.from({ length: 17 }, (_, row) => ({
    id: `scenario-${row + 1}`,
    action: `Scenario ${row + 1}: the person opens the merged task and reads its record`,
    result: "Passed live",
    reason: "The reading matched the expected record.",
    evidence: references
      .filter((_, index) => index % 17 === row)
      .map((n) => transcripts[n] as (typeof transcripts)[number]),
  })),
};

describe("the merge card's live validation table (INF-3887)", () => {
  const section = validationCard(summary);

  it("names each kept log by one line, its name and size, and writes none of its text", () => {
    for (const item of transcripts) {
      // A distinctive stretch of each transcript is nowhere in the card.
      expect(section).not.toContain(item.text.slice(1_000, 1_200));
    }
    expect(section).not.toContain("<pre");
    const first = transcripts[0] as (typeof transcripts)[number];
    expect(section).toContain(
      `<button type="button" data-inf-log="${cardLogUrl(first.file)}" data-inf-log-bytes="${first.bytes}">${first.description}</button>`,
    );
    expect(section).toContain(fileSizeWords(first.bytes));
    // Every log the card names is one the frame bridge may ask the reader to open.
    expect([...logSources(section)].sort()).toEqual(
      [...new Set(references)]
        .map((n) => cardLogUrl((transcripts[n] as { file: string }).file))
        .sort(),
    );
  });

  it("opens where the same rows with their transcripts pasted in were refused", () => {
    // What the host wrote before: each transcript inside the row that named it.
    const pasted = section.replace(
      /<button type="button" data-inf-log="[^"]+" data-inf-log-bytes="\d+">([^<]+)<\/button>/g,
      (_, description: string) =>
        `<details><summary>${description}</summary><pre>${html(
          transcripts.find((item) => item.description === description)?.text ?? "",
        )}</pre></details>`,
    );
    // The table sits on the card below the story's own sections, as it does on a merge card.
    const story = "<h3>Why</h3><p>A reopened task lost its record.</p><h3>After</h3>";
    const refusal = cardSizeRefusal(story + pasted);
    expect(cardWindowLength(story + pasted)).toBeGreaterThan(FRAME_TEMPLATE_MAX_BYTES);
    expect(refusal).toMatch(/^Card refused: the window would receive it at [\d,]+ characters/);
    expect(refusal).toContain(`over its limit of ${servedNumber(FRAME_TEMPLATE_MAX_BYTES)}`);
    expect(refusal).toMatch(
      /Its parts by size, in characters: live validation table under "After": [\d,]+;/,
    );

    expect(cardWindowLength(story + section)).toBeLessThan(FRAME_TEMPLATE_MAX_BYTES / 20);
    expect(cardSizeRefusal(story + section)).toBeUndefined();
  });
});
