import { customApiFailureCategorySchema, customNetworkLabel } from "@shared/customApi";
import { describe, expect, it } from "vitest";
import { placeCustomApiFailure } from "./customApiFailures";

const address = "https://gateway.example.com/team";

describe("where a custom connection's failure is told", () => {
  it("places every category somewhere, with words and never a raw state", () => {
    for (const category of customApiFailureCategorySchema.options)
      for (const stage of ["address", "list", "check"] as const) {
        const placed = placeCustomApiFailure(category, {
          address: "https://gateway.example.com/v1",
          stage,
          model: "gpt-4.1",
          listed: true,
        });
        if (placed.noList) continue;
        expect(placed.text).not.toMatch(/incompatible|key-rejected|unreachable|untested/);
        expect(placed.text.length).toBeGreaterThan(10);
      }
  });

  it("puts reaching the server at the address, and offers /v1 when nothing answered", () => {
    expect(placeCustomApiFailure("network", { address, stage: "list" })).toEqual({
      at: "address",
      text: "Could not reach gateway.example.com. Check that it is running and that you are on its network.",
    });
    expect(placeCustomApiFailure("not-found", { address, stage: "list" })).toEqual({
      at: "address",
      text: "Nothing answered at gateway.example.com/team/models. Many servers end in /v1.",
      fix: "https://gateway.example.com/team/v1",
      noList: true,
    });
    // Already versioned: a missing list just means there is none to read.
    expect(
      placeCustomApiFailure("not-found", { address: `${address}/v1`, stage: "list" }),
    ).toMatchObject({ noList: true });
    expect(
      placeCustomApiFailure("address", {
        address: `${address}/chat/completions`,
        stage: "address",
        suggestion: address,
      }),
    ).toMatchObject({ at: "address", fix: address });
  });

  it("makes a 404 the model's only when the model list answered", () => {
    expect(
      placeCustomApiFailure("not-found", { address, stage: "check", model: "m1", listed: true }),
    ).toEqual({ at: "row", text: "This server doesn't offer m1." });
    expect(
      placeCustomApiFailure("not-found", { address, stage: "check", model: "m1", listed: false }),
    ).toMatchObject({ at: "address", fix: "https://gateway.example.com/team/v1" });
  });

  it("puts a refused key at the key, and says a key is needed when none was sent", () => {
    expect(placeCustomApiFailure("key-rejected", { address, stage: "list", keyed: true })).toEqual({
      at: "key",
      text: "The server refused this key.",
    });
    expect(placeCustomApiFailure("key-rejected", { address, stage: "list", keyed: false })).toEqual(
      { at: "key", text: "This server needs a key." },
    );
    expect(placeCustomApiFailure("access-refused", { address, stage: "check" }).at).toBe("key");
  });

  it("puts a model's own failures on its row and the server's troubles above Save", () => {
    const row = (category: Parameters<typeof placeCustomApiFailure>[0]) =>
      placeCustomApiFailure(category, { address, stage: "check", model: "m1", listed: true });
    expect(row("incompatible")).toMatchObject({ at: "row", text: expect.stringMatching(/^m1 /) });
    expect(row("timeout")).toEqual({ at: "row", text: "m1 took too long to answer the test." });
    expect(row("limits")).toEqual({
      at: "row",
      text: "This server doesn't list this model's sizes. Enter its context and output tokens.",
    });
    expect(row("rate-limit").at).toBe("save");
    expect(row("server").at).toBe("save");
  });

  it("offers an organization's certificate only on an organization network", () => {
    expect(
      placeCustomApiFailure("certificate", { address, stage: "list", network: "private" }),
    ).toMatchObject({ at: "address", askCertificate: true });
    expect(
      placeCustomApiFailure("certificate", { address, stage: "list", network: "public" })
        .askCertificate,
    ).toBeUndefined();
  });

  it("names each network in the person's words", () => {
    expect(customNetworkLabel("local")).toBe("On this computer");
    expect(customNetworkLabel("private")).toBe("Your organization's network");
    expect(customNetworkLabel("public")).toBe("Public internet");
  });
});
