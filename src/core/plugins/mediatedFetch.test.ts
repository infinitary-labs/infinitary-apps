import { mediatedFetchCallSchema } from "@shared/plugins/fetch";
import { describe, expect, it } from "vitest";
import { createMediatedFetch, RETIRED_FETCH_WORDS } from "./mediatedFetch";

describe("the mediated fetch seam", () => {
  const call = mediatedFetchCallSchema.parse({
    pluginId: "jira",
    alias: "jira",
    request: { path: "/rest/api/3/search", query: { jql: "assignee=me" } },
  });

  it("refuses every call and sends nothing: a panel reaches a service through an integration", async () => {
    // The captain's answer on INF-2334: retire the per-panel hosts and keys.
    const fetchVia = createMediatedFetch();
    await expect(fetchVia(call)).resolves.toEqual({
      ok: false,
      error: { code: "capability_not_granted", message: RETIRED_FETCH_WORDS },
    });
  });

  it("keeps the plugin from naming a credential or identity header", () => {
    for (const header of ["Authorization", "cookie", "Host"]) {
      expect(
        mediatedFetchCallSchema.safeParse({
          ...call,
          request: { path: "/", headers: { [header]: "x" } },
        }).success,
        header,
      ).toBe(false);
    }
    expect(
      mediatedFetchCallSchema.safeParse({ ...call, request: { path: "//evil.example/" } }).success,
    ).toBe(false);
  });
});
