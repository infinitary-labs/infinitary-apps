import { describe, expect, it } from "vitest";
import { copyCount } from "./appArchive";

/**
 * The copy's count (docs/devices.md, "How far the copy has gone"): what
 * Settings -> Devices and the feed say while this Mac's Firstmate goes to
 * another Mac. The copy over a real SSH server is
 * `remoteLogin.test.ts`; this is the count's own rule.
 */
describe("the copy's count", () => {
  it("says the bytes sent so far at every piece when asked to, each more than the last", () => {
    const said: number[] = [];
    const copy = copyCount((sent) => said.push(sent), 0);
    for (const piece of [65_536, 65_536, 12_000]) copy.add(piece);
    copy.end();
    expect(said).toEqual([65_536, 131_072, 143_072]);
  });

  it("says its first bytes at once, then holds the count until its end says all it sent", () => {
    const said: number[] = [];
    const copy = copyCount((sent) => said.push(sent), Number.POSITIVE_INFINITY);
    copy.end();
    // Nothing sent yet, nothing said.
    expect(said).toEqual([]);
    for (const piece of [65_536, 65_536, 65_536, 1_024]) copy.add(piece);
    expect(said).toEqual([65_536]);
    copy.end();
    expect(said).toEqual([65_536, 197_632]);
    // Its end said once: nothing new, nothing said again.
    copy.end();
    expect(said).toEqual([65_536, 197_632]);
  });
});
