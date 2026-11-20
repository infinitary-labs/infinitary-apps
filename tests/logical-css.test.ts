import { expect, it } from "vitest";
import { logicalCssProblems } from "../scripts/logical-css";

// The approved plan (INF-3674): a right-to-left language ships in the first
// round, so the window lays out from the start of a line and mirrors.

it("accepts logical sides, a stated physical one, and words about sides in a comment", () => {
  const sheet = [
    "/* The age keeps the line's right edge. */",
    ".row { margin-inline-start: 4px; padding-inline-end: 2px; inset-inline-start: 0; text-align: start; }",
    ".tip { left: 50%; /* physical: centred with translateX(-50%), which mirrors to itself */ }",
    ":root { --rail-docked-left: 0px; }",
  ].join("\n");
  const code =
    'export const s = { marginInlineStart: 4, textAlign: "start", left: pointer.x, borderInlineStart: "1px solid" };';
  expect(
    logicalCssProblems({
      "src/renderer/src/app/row.css": sheet,
      "src/renderer/src/app/Row.tsx": code,
    }),
  ).toEqual([]);
});

it("refuses a physical side in a stylesheet and an inline style, outside the window's roots never", () => {
  const sheet =
    ".row {\n  margin-left: 4px;\n  right: 0;\n  text-align: left;\n  border-top-right-radius: 2px;\n}";
  const code = 'export const s = { paddingRight: 8, textAlign: "right" };';
  expect(
    logicalCssProblems({
      "src/renderer/src/app/row.css": sheet,
      "src/panels/now/Row.tsx": code,
      "src/core/runbooks/parts/map.css": ".x { margin-left: 4px; }",
    }).map((problem) => problem.replace(/ names a physical side.*/, "")),
  ).toEqual([
    "src/renderer/src/app/row.css:2: margin-left: 4px;",
    "src/renderer/src/app/row.css:3: right: 0;",
    "src/renderer/src/app/row.css:4: text-align: left;",
    "src/renderer/src/app/row.css:5: border-top-right-radius: 2px;",
    "src/panels/now/Row.tsx:1: paddingRight: 8",
    'src/panels/now/Row.tsx:1: textAlign: "right"',
  ]);
});
