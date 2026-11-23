// How the site joins a paragraph's sentence lines (docs/docs-site.md,
// "Translated pages"): a line break between Chinese or Japanese sentences
// draws nothing, while English, Korean and the rest keep their space. Each
// paragraph here is taken from the site's own pages, split into the pieces the
// Markdown step hands over: text, with { fixed } for inline code and the like.
// The site check (scripts/check-site.mjs) holds the built pages to it.
//
//   pnpm --dir docs-site test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinSentenceLines } from "../sentence-lines.mjs";

describe("a line break between Chinese or Japanese sentences draws nothing", () => {
  it("joins Chinese sentences, as on the Simplified Chinese home page", () => {
    assert.deepEqual(
      joinSentenceLines([
        "Infinitary 是你自己的 AI 工作室。\n它是一款适用于 macOS 和 Linux 的桌面应用。\n你只与一位大副交谈，由一队 AI 船员完成工作。",
      ]),
      ["Infinitary 是你自己的 AI 工作室。它是一款适用于 macOS 和 Linux 的桌面应用。你只与一位大副交谈，由一队 AI 船员完成工作。"],
    );
  });

  it("joins a sentence to a bold lead-in that ends in 。", () => {
    // - **你的电脑。**
    //   大副、船员们和你的项目都在你的电脑上。
    assert.deepEqual(joinSentenceLines(["你的电脑。", "\n大副、船员们和你的项目都在你的电脑上。"]), [
      "你的电脑。",
      "大副、船员们和你的项目都在你的电脑上。",
    ]);
  });

  it("puts no space after 。 before a Latin word or an opening quotation mark", () => {
    assert.deepEqual(
      joinSentenceLines([
        "有些会在你的浏览器中打开登录页面。\nCopilot 和 Kimi Code 会显示一个代码：点击“",
        "复制代码",
        "”，然后在服务商的网站上输入它。",
      ]),
      [
        "有些会在你的浏览器中打开登录页面。Copilot 和 Kimi Code 会显示一个代码：点击“",
        "复制代码",
        "”，然后在服务商的网站上输入它。",
      ],
    );
    assert.deepEqual(joinSentenceLines(["选择一项自动化即可阅读或更改它。\n“", "搜索自动化", "”可以按名称、提示或运行时间找到某一项。"]), [
      "选择一项自动化即可阅读或更改它。“",
      "搜索自动化",
      "”可以按名称、提示或运行时间找到某一项。",
    ]);
  });

  it("puts no space after a closing quotation mark that ends a Chinese sentence", () => {
    assert.deepEqual(
      joinSentenceLines([
        "在 Mac 上，列表下方的一行写着“保存在这台电脑上。你的船员会使用它们，但永远看不到。”\n在 Linux 上，这一行说明船员只有经你批准才会使用它们。",
      ]),
      ["在 Mac 上，列表下方的一行写着“保存在这台电脑上。你的船员会使用它们，但永远看不到。”在 Linux 上，这一行说明船员只有经你批准才会使用它们。"],
    );
    assert.deepEqual(
      joinSentenceLines(["在 Mac 上，清單下方那一行寫著「保存在這台電腦上。船員會使用它們，但永遠看不到。」\n在 Linux 上，它會說明船員只有在你核准後才會使用它們。"]),
      ["在 Mac 上，清單下方那一行寫著「保存在這台電腦上。船員會使用它們，但永遠看不到。」在 Linux 上，它會說明船員只有在你核准後才會使用它們。"],
    );
  });

  it("joins Japanese sentences, before a bracket, a number or a Latin word", () => {
    assert.deepEqual(
      joinSentenceLines([
        "パネルには、各自動化の状態と次の実行が一覧表示されます。\n1 つをクリックすると、設定でそれが開きます。",
      ]),
      ["パネルには、各自動化の状態と次の実行が一覧表示されます。1 つをクリックすると、設定でそれが開きます。"],
    );
    assert.deepEqual(
      joinSentenceLines(["次に起動したときに一等航海士を開きます。\n「ターミナル」から自分で起動した Infinitary の横にあるウインドウ"]),
      ["次に起動したときに一等航海士を開きます。「ターミナル」から自分で起動した Infinitary の横にあるウインドウ"],
    );
    assert.deepEqual(
      joinSentenceLines([
        "「ターミナル」で ",
        { fixed: "brew uninstall --cask infinitary" },
        " を実行します。\n",
        { fixed: "--zap" },
        " は決して付けないでください。保存した作業が削除されます。",
      ]),
      ["「ターミナル」で ", "brew uninstall --cask infinitary", " を実行します。", "--zap", " は決して付けないでください。保存した作業が削除されます。"],
    );
  });
});

describe("every other language keeps its space between sentence lines", () => {
  it("keeps Korean's space, which Korean puts between words", () => {
    const korean = "자동화는 일등항해사가 정해진 일정에 받는 메시지예요.\n일등항해사에게 전할 말을 쓰고, 언제 보낼지 고르세요.";
    assert.deepEqual(joinSentenceLines([korean]), [korean]);
  });

  it("keeps English's space", () => {
    const english = "Infinitary is your own AI studio.\nIt is a desktop app for macOS and Linux.\nYou talk to one first mate, and a crew of AI crewmates does the work.";
    assert.deepEqual(joinSentenceLines([english]), [english]);
  });

  it("keeps the space after a closing quotation mark in a Latin sentence", () => {
    const german =
      "Auf einem Mac steht in der Zeile unter der Liste: „Auf diesem Computer gespeichert. Deine Crew nutzt sie, sieht sie aber nie.“\nUnter Linux steht dort, dass deine Crew sie nur mit deiner Freigabe nutzt.";
    assert.deepEqual(joinSentenceLines([german]), [german]);
  });
});
