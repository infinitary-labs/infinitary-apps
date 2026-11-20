import { describe, expect, it } from "vitest";
import { callDigest, programRefusal } from "./programScript";

// INF-799 piece 2, the captain's Approve and build on "Plan task-graph
// programs, typed results first": a program is filed only when the host can
// run it, and a refused one files nothing; the journal keys each call by
// its digest so a replay takes the recorded answer.

/** A review program as the first mate writes one: find, then cap each file. */
const REVIEW = `
const found = await task("Find where a typed result is rendered.", { label: "find", schema: { type: "object" } });
return Promise.all(found.files.map((file) => task("Cap " + file, { after: ["find"] })));
`;

describe("what the host checks of a program before filing it", () => {
  it("files a script that compiles as an async body, with its bound", () => {
    expect(programRefusal({ script: REVIEW, bound: 6 })).toBeUndefined();
    expect(programRefusal({ script: REVIEW, bound: 6, args: { module: "meter" } })).toBeUndefined();
  });

  it("refuses a missing script, a bound that is not a whole number of at least 1, and a script that does not compile", () => {
    expect(programRefusal({ bound: 2 })).toContain("program.script must be");
    expect(programRefusal({ script: "  ", bound: 2 })).toContain("program.script must be");
    expect(programRefusal({ script: REVIEW })).toContain("program.bound must be");
    expect(programRefusal({ script: REVIEW, bound: 0 })).toContain("program.bound must be");
    expect(programRefusal({ script: REVIEW, bound: 2.5 })).toContain("program.bound must be");
    expect(programRefusal({ script: "return task(", bound: 2 })).toContain(
      "program.script does not compile",
    );
  });

  it("refuses a script that imports code, statically or at runtime", () => {
    expect(programRefusal({ script: 'import fs from "node:fs";', bound: 1 })).toContain(
      "does not compile",
    );
    expect(programRefusal({ script: 'const fs = await import("node:fs");', bound: 1 })).toContain(
      "imports code",
    );
  });

  it("refuses args that are not JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(programRefusal({ script: REVIEW, bound: 1, args: circular })).toBe(
      "program.args must be JSON.",
    );
  });
});

describe("the digest that keys a call in the journal", () => {
  it("is equal for equal calls whatever the key order, and differs when any argument does", () => {
    const a = callDigest("task", ["Cap meter.ts", { label: "cap", after: ["find"] }]);
    expect(callDigest("task", ["Cap meter.ts", { after: ["find"], label: "cap" }])).toBe(a);
    // An option left undefined is the same call as one never given.
    expect(
      callDigest("task", ["Cap meter.ts", { label: "cap", after: ["find"], schema: undefined }]),
    ).toBe(a);
    expect(callDigest("task", ["Cap gauge.ts", { label: "cap", after: ["find"] }])).not.toBe(a);
    expect(callDigest("ask", ["Cap meter.ts", { label: "cap", after: ["find"] }])).not.toBe(a);
  });
});
