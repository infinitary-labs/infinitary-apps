import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { requireConventional, requireConventionalRange } from "./conventional";
import { git } from "./git";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

describe("conventional save points", () => {
  it("accepts scoped, unscoped and breaking subjects; refuses plain names with a correction", () => {
    expect(requireConventional("fix(crew): correct title")).toBe("fix(crew): correct title");
    expect(requireConventional("feat!: change behavior")).toBe("feat!: change behavior");
    expect(() => requireConventional("Fix title")).toThrow(/fix\(crew\): correct naming/);
    expect(() => requireConventional("fix: ")).toThrow(/conventional name/);
  });

  it("checks incoming subjects but leaves historical base commits alone", async () => {
    const dir = scratchDir("fm-conventional-");
    await git(dir, ["init", "-q"]);
    const commit = async (subject: string) =>
      git(dir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--allow-empty",
        "-m",
        subject,
      ]);
    await commit("old plain subject");
    const base = await git(dir, ["rev-parse", "HEAD"]);
    await commit("fix: one change");
    await expect(requireConventionalRange(dir, base, "HEAD")).resolves.toBeUndefined();
    await commit("plain incoming subject");
    await expect(requireConventionalRange(dir, base, "HEAD")).rejects.toThrow(
      /plain incoming subject/,
    );
  });
});
