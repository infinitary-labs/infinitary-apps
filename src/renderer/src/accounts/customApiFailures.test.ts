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

  // INF-6842: a provider's refusal said "Try again in a moment", which never helps.
  it("tells a refusal above Save with the server's reason and no retry", () => {
    const reason = "Turn on the Global region setting in your console to use it.";
    expect(
      placeCustomApiFailure("server", { address, stage: "check", status: 400, reason }),
    ).toEqual({
      at: "save",
      text: "The server refused the request. It said: “Turn on the Global region setting in your console to use it.”",
    });
    expect(placeCustomApiFailure("server", { address, stage: "check", status: 422 })).toEqual({
      at: "save",
      text: "The server refused the request. Check this connection's settings with its provider.",
    });
    // A 5xx, or an older computer that sends no status, keeps the passing-trouble words.
    for (const status of [500, undefined])
      expect(placeCustomApiFailure("server", { address, stage: "check", status })).toEqual({
        at: "save",
        text: "The server could not complete the request. Try again in a moment.",
      });
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

// INF-3100: the refusal named no answer and no cause, so a person behind a
// fake-IP proxy could not tell why opencode.ai was refused. The captain asked
// that the form say what DNS answered.
describe("a refused destination says what DNS answered", () => {
  it("names each answer with its network, and why a reserved one appears", () => {
    expect(
      placeCustomApiFailure("destination", {
        address,
        stage: "address",
        answers: [
          { address: "198.18.0.42", kind: "reserved" },
          { address: "2606:4700:10::6814:2011", kind: "public" },
        ],
        exceptionOffered: true,
      }),
    ).toEqual({
      at: "address",
      text: `Infinitary can't send to this address. DNS answered 198.18.0.42 (reserved) and 2606:4700:10::6814:2011 (${customNetworkLabel("public").toLowerCase()}). A reserved answer often comes from a proxy app or a DNS filter that answers for every name.`,
    });
  });

  it("says answers span networks, and that no exception reaches this computer", () => {
    const placed = placeCustomApiFailure("destination", {
      address,
      stage: "address",
      who: "Mac mini",
      answers: [
        { address: "104.20.32.17", kind: "public" },
        { address: "10.0.0.5", kind: "private" },
        { address: "127.0.0.1", kind: "local" },
      ],
    });
    expect(placed.text).toBe(
      "Infinitary can't send to this address. DNS answered 104.20.32.17 (public internet), 10.0.0.5 (your organization's network) and 127.0.0.1 (on Mac mini). They point to more than one kind of network. Infinitary makes no exception for an answer that points to Mac mini, a link-local or a cloud metadata address.",
    );
  });

  it("keeps the general sentence for a literal address no DNS answered", () => {
    expect(
      placeCustomApiFailure("destination", {
        address: "http://169.254.169.254/v1",
        stage: "address",
      }).text,
    ).toBe(
      "Infinitary can't send to this address: it points to a reserved address, or to more than one kind of network.",
    );
  });
});
