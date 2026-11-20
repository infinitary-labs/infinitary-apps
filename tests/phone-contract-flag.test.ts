import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContractLine,
  contractLine,
  IPC_FILE,
  phoneFlag,
} from "../scripts/phone-contract-flag.ts";
import { PROTOCOL_VERSION, VIEW_FLOOR } from "../src/shared/ipc.ts";

const ipc = readFileSync(resolve(import.meta.dirname, "..", IPC_FILE), "utf8");

/** The ipc file as it read with another version and floor, the rest unchanged. */
const withLine = (version: string, floor: number) =>
  ipc
    .replace(
      /export const PROTOCOL_VERSION = "[^"]+";/,
      `export const PROTOCOL_VERSION = "${version}";`,
    )
    .replace(/export const VIEW_FLOOR = \d+;/, `export const VIEW_FLOOR = ${floor};`);
const lineOf = (version: string, floor: number) =>
  contractLine(withLine(version, floor)) as ContractLine;

/**
 * The phone contract flag (INF-4500's weekly audit, addition 4, which the
 * captain chose: "Flag a contract change that breaks phone views"). Seven
 * alpha cuts failed after a change moved the contract from major 14 to 15
 * and raised the view floor to 15 on purpose, and no phone build followed.
 */
describe("the phone contract flag", () => {
  it("reads the major and the view floor the ipc file declares", () => {
    expect(contractLine(ipc)).toEqual({
      major: Number(PROTOCOL_VERSION.split(".")[0]),
      floor: VIEW_FLOOR,
    });
  });

  it("names the phone build when a change raises the major and the view floor", () => {
    const flag = phoneFlag(lineOf("14.0.0", 14), lineOf("15.0.0", 15));
    expect(flag).toContain("the contract's major from 14 to 15 and the view floor from 14 to 15");
    expect(flag).toContain('"The phone goes first"');
    expect(flag).toContain("after-merge step");
  });

  it("names a major that moves alone", () => {
    const flag = phoneFlag(lineOf("15.2.0", 15), lineOf("16.0.0", 15));
    expect(flag).toContain("the contract's major from 15 to 16 (");
  });

  it("says nothing for a minor version or no move", () => {
    const line = lineOf("16.0.0", 15);
    expect(phoneFlag(line, lineOf("16.1.0", 15))).toBeUndefined();
    expect(phoneFlag(line, line)).toBeUndefined();
  });
});
