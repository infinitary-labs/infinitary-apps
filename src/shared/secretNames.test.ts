import { describe, expect, it } from "vitest";
import { needsReference, secretName } from "./secretNames";

// Intent: the captain's INF-1109 Secrets UX request requires unmistakable
// identities, and INF-1690's piece 1 lists saved decisions in plain sentences
// on the Secrets page. A saved decision must never appear to name a different
// secret.
const entries = [
  { ref: "website-production", label: "Website deployment", environment: "Production" },
  { ref: "website-production-mirror", label: "Website deployment", environment: "Production" },
  { ref: "website-staging", label: "Website deployment", environment: "Staging" },
  { ref: "planning-calendar", label: "Planning calendar", environment: "Personal" },
];

describe("a secret's name in a sentence", () => {
  it("distinguishes duplicate names and places without naming another secret", () => {
    const names = entries.map((entry) => secretName(entries, entry.ref));
    expect(new Set(names).size).toBe(entries.length);
    expect(secretName(entries, "website-staging")).toBe("Website deployment (Staging)");
    for (const ref of ["website-production", "website-production-mirror"]) {
      const name = secretName(entries, ref);
      expect(name).toContain("Website deployment");
      expect(name).toContain("Production");
      expect(name).toContain(ref);
    }
    expect(needsReference(entries, entries[0] as (typeof entries)[number])).toBe(true);
    expect(needsReference(entries, entries[2] as (typeof entries)[number])).toBe(false);
  });
  it("names a lone secret by its name alone", () => {
    expect(secretName(entries, "planning-calendar")).toBe("Planning calendar");
  });
  it("keeps an unavailable saved reference instead of naming the first remaining secret", () => {
    const removed = "retired-website-credential";
    const name = secretName(entries, removed);
    expect(name).toContain(removed);
    for (const entry of entries) expect(name).not.toContain(entry.label);
  });
});
