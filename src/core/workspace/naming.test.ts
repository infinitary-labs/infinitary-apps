import { describe, expect, it, vi } from "vitest";
import { BUNDLED_NAMING } from "../../../tests/helpers/namingRunbook";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { git } from "./git";
import { requireNamed, requireNamedRange } from "./naming";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

// Intent: the bundled Commit and PR naming runbook's convention, checked through its own rule.
describe("save points under the bundled naming runbook", () => {
  it("accepts scoped, unscoped and breaking subjects; refuses plain names with a correction", () => {
    const named = (name: string) => requireNamed(name, "commit", BUNDLED_NAMING);
    expect(named("fix(crew): correct title")).toBe("fix(crew): correct title");
    expect(named("feat!: change behavior")).toBe("feat!: change behavior");
    expect(() => named("Fix title")).toThrow(/fix\(crew\): correct naming/);
    expect(() => named("fix: ")).toThrow(/does not follow the naming runbook/);
  });

  it("checks incoming subjects but leaves historical base commits alone", async () => {
    const dir = scratchDir("fm-naming-");
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
    await expect(requireNamedRange(dir, base, "HEAD", BUNDLED_NAMING)).resolves.toBeUndefined();
    await commit("plain incoming subject");
    await expect(requireNamedRange(dir, base, "HEAD", BUNDLED_NAMING)).rejects.toThrow(
      /plain incoming subject/,
    );
  });
});
