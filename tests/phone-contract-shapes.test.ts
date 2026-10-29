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
    ["inf:cards:list", "body"],
    ["inf:cards:list", "actions"],
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
  // INF-64 piece 5: contract evolution cannot silently break Talk or Tasks decoders.
  it.each([
    ["inf:tasks:board", ["properties", "tasks", "items"], "title"],
    ["inf:tasks:detail", [], "key"],
    ["inf:tasks:detail", ["properties", "events", "items"], "text"],
    ["inf:tasks:search", ["items"], "id"],
    ["inf:tasks:crewmate", [], "lines"],
    ["inf:tasks:crewmate:live", [], "text"],
  ] as const)("refuses an incompatible native work reading in %s", (channel, path, field) => {
    const changed = contract();
    let row = changed.requests[channel].response;
    for (const part of path) row = row[part];
    row.required = row.required.filter((key: string) => key !== field);
    expect(() => assertPhoneReaderShapes(changed)).toThrow(`must require ${field}`);
  });
  // INF-1854: the phone applies the board delta it is pushed, so its decoder's fields stay published.
  it.each([
    [[], "baseSeq"],
    [["properties", "upserts", "items"], "createdAt"],
    [["properties", "links", "properties", "added", "items"], "toId"],
  ] as const)("refuses an incompatible board delta at %j field %s", (path, field) => {
    const changed = contract();
    let row = changed.pushes["inf:tasks:delta"].payload;
    for (const part of path) row = row[part];
    row.required = row.required.filter((key: string) => key !== field);
    expect(() => assertPhoneReaderShapes(changed)).toThrow(`must require ${field}`);
  });
  // INF-82's live character must keep consuming the real typed conversation state.
  it("refuses a missing or incompatible first-mate busy event", () => {
    const missing = contract();
    const events = missing.pushes["inf:event"].payload.oneOf;
    missing.pushes["inf:event"].payload.oneOf = events.filter(
      (event: { properties: { type: { const: string } } }) =>
        event.properties.type.const !== "firstmate_state",
    );
    expect(() => assertPhoneReaderShapes(missing)).toThrow("firstmate_state must require busy");
    const changed = contract();
    const busy = changed.pushes["inf:event"].payload.oneOf.find(
      (event: { properties: { type: { const: string } } }) =>
        event.properties.type.const === "firstmate_state",
    );
    busy.properties.busy = { type: "string" };
    expect(() => assertPhoneReaderShapes(changed)).toThrow("firstmate_state must require busy");
  });
  it("refuses replacing the pushed card rows with a wrapper", () => {
    const changed = contract();
    changed.pushes["inf:cards"].payload = { type: "object" };
    expect(() => assertPhoneReaderShapes(changed)).toThrow("inf:cards must return an array");
  });
});
