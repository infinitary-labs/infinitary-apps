import { mediatedFetchCallSchema } from "@shared/plugins/fetch";
import { describe, expect, it } from "vitest";
import { createMediatedFetch, noNetGrants } from "./mediatedFetch";

describe("the mediated fetch seam", () => {
  const call = mediatedFetchCallSchema.parse({
    pluginId: "jira",
    alias: "jira",
    request: { path: "/rest/api/3/search", query: { jql: "assignee=me" } },
  });

  it("refuses every call while no grant is served, naming the plugin and alias", async () => {
    const fetchVia = createMediatedFetch({ grants: noNetGrants });
    await expect(fetchVia(call)).resolves.toEqual({
      ok: false,
      error: {
        code: "capability_not_granted",
        message: 'plugin "jira" holds no net grant for "jira"',
      },
    });
  });

  it("refuses a method outside the grant before anything else", async () => {
    const fetchVia = createMediatedFetch({
      grants: () => ({ jira: { origin: "https://acme.atlassian.net", methods: ["GET"] } }),
    });
    const result = await fetchVia({ ...call, request: { ...call.request, method: "POST" } });
    expect(result).toEqual({
      ok: false,
      error: { code: "method_not_granted", message: '"jira" grants GET, not POST' },
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
