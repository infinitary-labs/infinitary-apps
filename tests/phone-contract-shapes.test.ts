import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPhoneReaderShapes } from "../scripts/phone-contract-shapes";

// INF-136 #7: accepting a new contract version must not silently break the native decoders.
const contract = () => JSON.parse(readFileSync("docs/contract.json", "utf8"));
describe("the native reader's published response shapes", () => {
  it("accepts the actual published cards, feed and card-push shapes", () => {
    expect(() => assertPhoneReaderShapes(contract())).not.toThrow();
  });
  it.each([
    ["inf:cards:list", "id"],
    ["inf:cards:list", "title"],
    ["inf:cards:list", "author"],
    ["inf:feed:recent", "kind"],
    ["inf:feed:recent", "text"],
    ["inf:feed:recent", "at"],
  ])("refuses a missing or incompatible %s field %s", (channel, field) => {
    const missing = contract();
    const row = missing.requests[channel].response.items;
    row.required = row.required.filter((key: string) => key !== field);
    expect(() => assertPhoneReaderShapes(missing)).toThrow(`must require ${field}`);
    const changed = contract();
    changed.requests[channel].response.items.properties[field] = { type: "object" };
    expect(() => assertPhoneReaderShapes(changed)).toThrow(`must require ${field}`);
  });
  it("refuses replacing the pushed card rows with a wrapper", () => {
    const changed = contract();
    changed.pushes["inf:cards"].payload = { type: "object" };
    expect(() => assertPhoneReaderShapes(changed)).toThrow("inf:cards must return an array");
  });
});
