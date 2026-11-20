import { createHash } from "node:crypto";
import { createReadStream, type ReadStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hashFile } from "./record";

/**
 * INF-4260's plan, piece 11: Windows refuses to rename or remove a folder
 * holding an open file, and a copy is renamed into place, or a record set
 * aside, right after its files are hashed. A hash must not answer while its
 * read still holds the file open.
 */
describe("a file's hash", () => {
  it("answers only once the file it read is closed again", async () => {
    const file = join(scratchDir("infinitary-record-hash-"), "transcript.jsonl");
    const data = Buffer.from('{"line":1}\n'.repeat(10_000));
    writeFileSync(file, data);
    const reads: ReadStream[] = [];
    const sha256 = await hashFile(file, (path) => {
      const stream = createReadStream(path);
      reads.push(stream);
      return stream;
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.closed).toBe(true);
    expect(sha256).toBe(createHash("sha256").update(data).digest("hex"));
  });
});
