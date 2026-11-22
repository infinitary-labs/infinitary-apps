import { describe, expect, it } from "vitest";
import { compareBuilds } from "./buildIdentity";

// INF-5635's plan, piece 3: computers compare build identity, by commit when the home runs
// source, and one Match brings each to the home's build.

const A = "a".repeat(40);
const B = "b".repeat(40);
const sourceAt = (commit?: string) => ({
  ...(commit ? { commit } : {}),
  source: true as const,
});

describe("comparing a computer's build with the home's", () => {
  it("matches a home run from source by commit, whatever version label either says", () => {
    const home = { contract: "48.2.0", app: "0.8.6-alpha.20", build: sourceAt(A) };
    expect(compareBuilds(home, { contract: "48.2.0", app: "0.8.1", build: sourceAt(A) })).toEqual({
      same: true,
    });
    // Another commit, or an installed release on the same label, is matched to the home's commit.
    expect(compareBuilds(home, { contract: "48.2.0", build: sourceAt(B) })).toEqual({
      same: false,
      target: "source",
    });
    expect(
      compareBuilds(home, { contract: "48.2.0", app: "0.8.6-alpha.20", build: { commit: A } }),
    ).toEqual({ same: false, target: "source" });
    // A computer behind on the contract is said to be older, which holds new work there.
    expect(compareBuilds(home, { contract: "47.0.0", build: sourceAt(B) })).toEqual({
      same: false,
      target: "source",
      than: "older",
    });
  });

  it("brings a computer that runs source back to the release a home on a release runs", () => {
    const home = { contract: "48.2.0", app: "0.8.6-alpha.20", build: { commit: A } };
    expect(
      compareBuilds(home, { contract: "48.2.0", app: "0.8.6-alpha.20", build: sourceAt(A) }),
    ).toEqual({ same: false, target: "release" });
  });

  it("compares two releases by their versions, as it always has", () => {
    const home = { contract: "48.2.0", app: "0.8.6", build: { commit: A } };
    expect(compareBuilds(home, { contract: "48.2.0", app: "0.8.6", build: { commit: B } })).toEqual(
      {
        same: true,
      },
    );
    expect(compareBuilds(home, { contract: "48.2.0", app: "0.8.5" })).toEqual({
      same: false,
      target: "release",
      than: "older",
    });
  });
});
