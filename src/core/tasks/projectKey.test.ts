import { TASK_KEY_EXACT, taskKeysIn } from "@shared/taskKeys";
import { describe, expect, it } from "vitest";
import { deriveProjectKey, normalizeProjectKey, PROJECT_KEY_PATTERN } from "./projectKey";

describe("deriveProjectKey", () => {
  it("takes two letters of the first word plus initials of the rest", () => {
    expect(deriveProjectKey("firstmate-3000", [])).toBe("FI3");
    expect(deriveProjectKey("eddies wallet", [])).toBe("EDW");
    expect(deriveProjectKey("quota-axi-cli-tool", [])).toBe("QUAC");
  });

  it("walks a deterministic ladder on collisions", () => {
    expect(deriveProjectKey("zephyr", ["ZEPH"])).toBe("ZEP2");
    expect(deriveProjectKey("zephyr", ["ZEPH", "ZEP2", "ZEP3"])).toBe("ZEP4");
    const taken = ["ZEPH", ...Array.from({ length: 8 }, (_, i) => `ZEP${i + 2}`)];
    expect(deriveProjectKey("zephyr", taken)).toBe("ZE10");
  });

  it("still yields a valid key for a name with no usable characters", () => {
    expect(deriveProjectKey("---", [])).toMatch(/^[A-Z0-9]{2,4}$/);
    expect(deriveProjectKey("", [])).toMatch(/^[A-Z0-9]{2,4}$/);
  });

  it("compares taken keys case-insensitively", () => {
    expect(deriveProjectKey("zephyr", ["zeph"])).toBe("ZEP2");
  });
});

describe("normalizeProjectKey", () => {
  it("uppercases and validates", () => {
    expect(normalizeProjectKey(" fm3k ")).toBe("FM3K");
    expect(() => normalizeProjectKey("toolong")).toThrow(/2-4/);
    expect(() => normalizeProjectKey("a")).toThrow(/2-4/);
    expect(() => normalizeProjectKey("a-b")).toThrow(/2-4/);
  });
});

describe("task keys in text (FI3-594)", () => {
  it("reads every key a project key can make, and only those", () => {
    const projects = ["FI3", "SCR", "IO", "ZE10", deriveProjectKey("quota-axi-cli-tool", [])];
    for (const project of projects) {
      expect(project).toMatch(PROJECT_KEY_PATTERN);
      expect(TASK_KEY_EXACT.test(`${project}-12`)).toBe(true);
      expect(taskKeysIn(`see ${project}-12.`)).toEqual([`${project}-12`]);
    }
    for (const project of ["F", "ABCDE", "fi3"]) {
      expect(project).not.toMatch(PROJECT_KEY_PATTERN);
      expect(taskKeysIn(`see ${project}-12.`)).toEqual([]);
    }
  });
});
