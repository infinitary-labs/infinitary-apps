import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { insertVoiceTranscript, isAudioSilent, isLikelyHallucination } from "./voiceInput";

describe("isAudioSilent", () => {
  it("gates on RMS with the 0.006 default threshold", () => {
    expect(isAudioSilent(new Float32Array(1000))).toBe(true);
    expect(isAudioSilent(new Float32Array(1000).fill(0.005))).toBe(true);
    expect(isAudioSilent(new Float32Array(1000).fill(0.05))).toBe(false);
    expect(isAudioSilent(new Float32Array(0))).toBe(true);
  });
});

describe("isLikelyHallucination", () => {
  it("drops whole-transcript stock phrases only", () => {
    expect(isLikelyHallucination("Thank you.")).toBe(true);
    expect(isLikelyHallucination("thanks for watching")).toBe(true);
    expect(isLikelyHallucination("")).toBe(true);
    expect(isLikelyHallucination("Thank you for fixing the retry helper")).toBe(false);
    expect(isLikelyHallucination("refactor the auth middleware")).toBe(false);
  });

  it("keeps words in every script (INF-608)", () => {
    // The pinned Whisper model's own words for synthetic Mandarin, Japanese
    // and Korean recordings (macOS's Tingting, Kyoko and Eddy voices).
    expect(isLikelyHallucination("请帮我检查语音输入的效果,我希望说话的时候就能看到文字。")).toBe(
      false,
    );
    expect(isLikelyHallucination("音声入力の結果を確認してください。")).toBe(false);
    expect(isLikelyHallucination("음성 입력 결과를 확인해 주세요.")).toBe(false);
  });
});

describe("insertVoiceTranscript", () => {
  const at = (marked: string, transcript: string) => {
    const caret = marked.indexOf("|");
    const next = insertVoiceTranscript(marked.replace("|", ""), caret, transcript);
    return `${next.text.slice(0, next.caret)}|${next.text.slice(next.caret)}`;
  };

  it("lands at the start, the middle and the end with a space only where one is needed", () => {
    expect(at("|", "fix the tests")).toBe("fix the tests |");
    expect(at("|and then ship", "fix the tests")).toBe("fix the tests |and then ship");
    expect(at("fix the |tests", "flaky")).toBe("fix the flaky |tests");
    expect(at("fix the|tests", "flaky")).toBe("fix the flaky |tests");
    expect(at("Please describe|", "an ocean of stars")).toBe("Please describe an ocean of stars |");
    expect(at("first part |", "second part")).toBe("first part second part |");
  });

  it("starts a line cleanly after a line break", () => {
    expect(at("Steps:\n|", "run it")).toBe("Steps:\nrun it |");
    expect(at("Steps:\n|\nthen", "run it")).toBe("Steps:\nrun it|\nthen");
  });

  it("leaves no space before closing punctuation or after an opening bracket", () => {
    expect(at("Look at this|.", "retry helper")).toBe("Look at this retry helper|.");
    expect(at("the fix (|)", "retry")).toBe("the fix (retry|)");
    expect(at("done|, then", "mostly")).toBe("done mostly|, then");
  });

  it("reads no caret, or one past the draft, as its end, and ignores an empty transcript", () => {
    expect(insertVoiceTranscript("draft", null, "more")).toEqual({
      text: "draft more ",
      caret: "draft more ".length,
    });
    expect(insertVoiceTranscript("draft", 99, "more").text).toBe("draft more ");
    expect(insertVoiceTranscript("draft", 2, "  ")).toEqual({ text: "draft", caret: 2 });
  });
});

describe("VoiceInput chips", () => {
  it("puts pictures and pasted text in the shell's own chip row, each with named controls", async () => {
    const { VoiceInput } = await import("../design/voice/VoiceInput");
    const markup = renderToStaticMarkup(
      createElement(VoiceInput, {
        attachments: [{ id: "shot", preview: "data:image/png;base64,AA==", name: "shot.png" }],
        pastes: [{ id: "log", text: "\n  first words here\nsecond\nthird" }],
      }),
    );
    const shell = markup.slice(markup.indexOf("data-voice-input-shell"));
    const chips = shell.slice(shell.indexOf("data-voice-input-chips"));
    expect(chips).toContain("data-voice-input-attachment");
    expect(chips).toContain("data-voice-input-paste");
    expect(markup).toContain('aria-label="Remove shot.png"');
    expect(markup).not.toContain('aria-label="Put the pasted text back in the message"');
    expect(markup).toContain('aria-label="Remove file, 4 lines"');
    expect(markup).toContain("first words here");
    // A chip makes the draft multi-line: the foot row carries the send control.
    expect(markup.slice(markup.indexOf("data-voice-input-foot"))).toContain('aria-label="Submit"');
  });
});

describe("acceptedImageFiles (paste-to-attach filter)", () => {
  const item = (type: string, size: number, name = "shot.png") => ({
    type,
    getAsFile: () => ({ name, size }) as File,
  });

  it("keeps every accepted image in one paste and preserves its mime type", async () => {
    const { acceptedImageFiles } = await import("../design/core/ComposerField");
    const picked = acceptedImageFiles([
      item("image/png", 100, "a.png"),
      item("text/plain", 5),
      item("image/jpeg", 200, "b.jpg"),
    ]);
    expect(picked.map((p) => p.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(picked.map((p) => p.file.name)).toEqual(["a.png", "b.jpg"]);
  });

  it("drops unsupported types, oversized files, and fileless items", async () => {
    const { acceptedImageFiles } = await import("../design/core/ComposerField");
    expect(acceptedImageFiles(undefined)).toEqual([]);
    expect(acceptedImageFiles([item("image/tiff", 10)])).toEqual([]);
    expect(acceptedImageFiles([item("image/svg+xml", 10)])).toEqual([]);
    expect(acceptedImageFiles([item("image/png", 5 * 1024 * 1024 + 1)])).toEqual([]);
    expect(acceptedImageFiles([{ type: "image/png", getAsFile: () => null }])).toEqual([]);
  });

  it("counts the accepted-type pictures over the size cap, so a refusal is said out loud", async () => {
    const { tooBigImageCount } = await import("../design/core/ComposerField");
    expect(tooBigImageCount(undefined)).toBe(0);
    expect(tooBigImageCount([item("image/png", 5 * 1024 * 1024)])).toBe(0);
    expect(
      tooBigImageCount([
        item("image/png", 5 * 1024 * 1024 + 1),
        item("image/jpeg", 10),
        item("image/tiff", 6 * 1024 * 1024),
        item("image/webp", 9 * 1024 * 1024),
      ]),
    ).toBe(2);
  });
});
