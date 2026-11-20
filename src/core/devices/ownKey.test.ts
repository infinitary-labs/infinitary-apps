import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { OWN_KEY_FOLDER, readOwnKey } from "./ownKey";

const KEY_BODY = "AAAAC3NzaC1lZDI1NTE5AAAAIFixtureOnlyNotAKeyAAAAAAAAAAAAAAAAAAAAAAAA";

function keyWithComment(comment: string): string {
  const dir = scratchDir("fm-own-key-");
  const folder = join(dir, OWN_KEY_FOLDER);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "id_ed25519"), "private");
  writeFileSync(join(folder, "id_ed25519.pub"), `ssh-ed25519 ${KEY_BODY} ${comment}\n`);
  return dir;
}

describe("the Mac's own SSH key", () => {
  it("reads a key that names itself Firstmate 3000, as this app writes it", () => {
    expect(readOwnKey(keyWithComment("firstmate-3000"))).not.toBeNull();
  });

  it("reads a key that names itself Infinitary, too", () => {
    expect(readOwnKey(keyWithComment("infinitary"))).not.toBeNull();
  });

  it("refuses a key that names itself anything else", () => {
    expect(readOwnKey(keyWithComment("someone-else"))).toBeNull();
  });
});
