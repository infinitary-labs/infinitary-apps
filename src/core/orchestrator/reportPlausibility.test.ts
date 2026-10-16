import { describe, expect, it } from "vitest";
import { implausibleReport } from "./reportPlausibility";

describe("implausibleReport", () => {
  it("sets aside the Sep 14 garbage turn text", () => {
    expect(implausibleReport("RGCTXDataിക്ഷassistant to=functions.bash 新天天彩票?")).toBeDefined();
  });

  it("names each failure it detects", () => {
    expect(implausibleReport("Done.")).toBe("it has fewer than 2 words");
    expect(implausibleReport("   ")).toBe("it has fewer than 2 words");
    expect(implausibleReport("Checked the tree assistant to=functions.bash now")).toBe(
      "it contains tool-call syntax instead of prose",
    );
    expect(implausibleReport("Opened the PR <|call|> and waited")).toBe(
      "it contains tool-call syntax instead of prose",
    );
    expect(implausibleReport("Tests pаssed on the branch")).toBe(
      // The "а" is Cyrillic: a homoglyph inside a Latin word.
      "it mixes writing systems inside one word",
    );
    expect(implausibleReport("Готово, تم, and done")).toBe(
      "it mixes more than two writing systems",
    );
  });

  it("accepts ordinary reports, including quoted fragments and mixed CJK prose", () => {
    expect(implausibleReport("All done.")).toBeUndefined();
    expect(
      implausibleReport(
        "PR 96 is open and CI is green. The garbage text contained `to=functions.bash`, which the report channel now rejects.",
      ),
    ).toBeUndefined();
    expect(implausibleReport("修复了quota meter的bug，测试已通过。")).toBeUndefined();
    expect(implausibleReport("Latency dropped from 40ms to 3μs after caching.")).toBeUndefined();
    expect(implausibleReport("Готово: тесты проходят, PR открыт.")).toBeUndefined();
  });
});
