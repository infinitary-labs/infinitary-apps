import { afterEach, describe, expect, it, vi } from "vitest";
import { SIZE_CEILING, sizeProblems } from "../scripts/file-sizes.ts";
import {
  errorLine,
  leadingPath,
  printErrors,
  staleGeneratedFile,
} from "../scripts/github-errors.ts";

/**
 * INF-4305's finding: the size, generated-file and release-note checks
 * printed their refusal as plain text, so GitHub's summary of a failed check
 * said only "Process completed with exit code 1." (docs/testing.md, "A failed
 * check says why"). Inside GitHub Actions each refusal is an error line the
 * summary shows, naming its file; anywhere else it stays the plain line.
 */
const ACTIONS = { GITHUB_ACTIONS: "true" };

// The refusal that held a merge batch: two changes together pushed one file past the ceiling.
const [sizeRefusal] = sizeProblems({ "src/shared/work.ts": SIZE_CEILING + 9 }, []);

describe("a check's refusal as GitHub reads it", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the size check's refused file and keeps its words inside GitHub Actions", () => {
    expect(errorLine(sizeRefusal!, { title: "Size check" }, ACTIONS)).toBe(
      `::error file=src/shared/work.ts,title=Size check::${sizeRefusal}`,
    );
  });

  it("prints the plain refusal outside GitHub Actions", () => {
    expect(errorLine(sizeRefusal!, { title: "Size check" }, {})).toBe(sizeRefusal);
    expect(errorLine(sizeRefusal!, {}, { GITHUB_ACTIONS: "false" })).toBe(sizeRefusal);
  });

  it("keeps a refusal of several lines and its percent signs whole in one error line", () => {
    const line = errorLine(
      "release-notes/changes/a.json: 100% of\nits entries lack an area",
      {},
      ACTIONS,
    );
    expect(line).toBe(
      "::error file=release-notes/changes/a.json::release-notes/changes/a.json: 100%25 of%0Aits entries lack an area",
    );
  });

  it("names a file only where the refusal leads with a path", () => {
    expect(leadingPath("scripts/file-sizes.ts: tests/helpers/phoneHome.ts is listed")).toBe(
      "scripts/file-sizes.ts",
    );
    expect(leadingPath("usage: release-notes.ts validate | change")).toBeUndefined();
    expect(leadingPath("this change adds no file under release-notes/changes/")).toBeUndefined();
    expect(errorLine("usage: release-notes.ts validate", { title: "Release notes" }, ACTIONS)).toBe(
      "::error title=Release notes::usage: release-notes.ts validate",
    );
  });

  it("prints every refusal of a check on standard error", () => {
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => printed.push(line));
    printErrors([sizeRefusal!, "plain words"], { title: "Size check" }, ACTIONS);
    expect(printed).toEqual([
      `::error file=src/shared/work.ts,title=Size check::${sizeRefusal}`,
      "::error title=Size check::plain words",
    ]);
  });

  it("names a generated file out of step and the command that refreshes it, and still fails the step", () => {
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => printed.push(line));
    const error = staleGeneratedFile(
      "ios/Infinitary/InfinitaryApp/PhoneTheme.generated.swift",
      "node scripts/generate-phone-theme.ts",
      ACTIONS,
    );
    expect(error).toBeInstanceOf(Error);
    expect(printed).toEqual([
      "::error file=ios/Infinitary/InfinitaryApp/PhoneTheme.generated.swift,title=Generated file out of step::ios/Infinitary/InfinitaryApp/PhoneTheme.generated.swift: out of step with its generator; run node scripts/generate-phone-theme.ts and commit the result",
    ]);
  });
});
