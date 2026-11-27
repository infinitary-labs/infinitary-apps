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

  it("accepts a report that quotes translations in several writing systems", () => {
    // A crewmate's final text from Nov 12, set aside by the old whole-report count of writing
    // systems: it quotes a Japanese and an Arabic translation beside English, each word whole.
    const report = [
      "I've opened PR #1655 from my own task branch. The pull request's main Linux check is still running, so there is no merge card yet.",
      "",
      '- **The fix:** in the Devices tab, the address tag mixed English into the translated phrase ("this computer のみ" in Japanese, "this computer فقط" in Arabic). I added one message, "this computer only", with all nine translations and rebuilt the compiled catalog.',
    ].join("\n");
    expect(implausibleReport(report)).toBeUndefined();
    expect(implausibleReport("Готово, تم, and done")).toBeUndefined();
  });

  it("accepts Japanese prose whose katakana words carry the long-vowel mark", () => {
    // Unicode files ー (U+30FC) under no script of its own, so these words once read as katakana
    // mixed with another writing system and the report was refused.
    expect(
      implausibleReport(
        "コンピューターでクルーの作業を確認しました。サーバーとユーザーの設定のテストが通り、PRを開きました。",
      ),
    ).toBeUndefined();
    expect(
      implausibleReport(
        "Two messages use クルー for crew, and nine spell コンピュータ where the glossary says コンピューター.",
      ),
    ).toBeUndefined();
    // Halfwidth katakana: the prolonged mark ｰ and the sound mark ﾟ are script-less too.
    expect(implausibleReport("ｺﾝﾋﾟｭｰﾀｰの設定を確認しました。")).toBeUndefined();
  });

  it("lets a script-less letter take the writing system beside it", () => {
    expect(implausibleReport("Latency dropped from 40ms to 3µs after caching.")).toBeUndefined();
    expect(implausibleReport("Перевод слова мʼясо готов.")).toBeUndefined();
    expect(implausibleReport("ترجمة كـتاب جاهزة الآن.")).toBeUndefined();
    expect(implausibleReport("Checked the コンピューターпривет line")).toBe(
      "it mixes writing systems inside one word",
    );
  });
});
