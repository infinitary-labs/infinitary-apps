import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReadTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { customPicture } from "../../../tests/helpers/customPictures";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { COMPACTED_PICTURES_NOTICE, customPictureContext } from "./customPictureContext";

afterEach(() => vi.restoreAllMocks());

async function pictureHistory() {
  const root = scratchDir("custom-picture-context-");
  const manager = SessionManager.create(root, join(root, "sessions"));
  const path = join(root, "crop.png");
  writeFileSync(path, Buffer.from(customPicture(32, 24), "base64"));
  const result = await createReadTool(root, { autoResizeImages: false }).execute("read-crop", {
    path,
  });
  expect(result.content.some((block) => block.type === "image")).toBe(true);
  manager.appendMessage({ role: "user", content: "Compare the crops.", timestamp: 0 });
  manager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "fm-custom-test",
    model: "test",
    content: [{ type: "toolCall", id: "read-crop", name: "read", arguments: { path } }],
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 30,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 38,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  manager.appendMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-crop",
    content: result.content,
    isError: false,
    timestamp: 1,
  });
  // A real completed reply also makes Pi flush the file-backed session.
  manager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "fm-custom-test",
    model: "test",
    content: [{ type: "text", text: "Crop opened." }],
    stopReason: "stop",
    timestamp: 2,
    usage: {
      input: 30,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 38,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  return { manager, root };
}

// INF-1996 pictures=keep: only an actual compaction omission earns a picture-loss notice.
it("keeps the current picture context unchanged and gives no false loss notice", async () => {
  const { manager } = await pictureHistory();
  const project = customPictureContext(manager);
  const messages = manager.buildSessionContext().messages;
  expect(project(messages)).toBe(messages);
  const first = manager.getBranch()[0];
  if (!first) throw new Error("Picture history is missing");
  manager.appendCompaction("Comparison so far.", first.id, 100);
  const kept = manager.buildSessionContext().messages;
  expect(project(kept)).toEqual(kept);
  expect(JSON.stringify(project(kept))).not.toContain(COMPACTED_PICTURES_NOTICE);
});

it("derives a stable truthful loss notice from the saved cut, including after resume and another compaction", async () => {
  const { manager, root } = await pictureHistory();
  const keep = manager.appendMessage({
    role: "user",
    content: "Continue the comparison.",
    timestamp: 3,
  });
  const originalEntries = structuredClone(manager.getEntries());
  manager.appendCompaction("Comparison so far.", keep, 100);
  const record = manager.getSessionFile();
  if (!record) throw new Error("Picture session record is missing");
  const diskBefore = readFileSync(record, "utf8");
  const active = manager.buildSessionContext().messages;
  const originalActive = structuredClone(active);
  const branchRead = vi.spyOn(manager, "getBranch");
  const project = customPictureContext(manager);
  const noticed = project(active);
  expect(noticed[0]).toMatchObject({
    role: "compactionSummary",
    summary: `Comparison so far.\n\n${COMPACTED_PICTURES_NOTICE}`,
  });
  expect(JSON.stringify(noticed)).not.toContain('"type":"image"');
  expect(project(active)).toEqual(noticed);
  expect(branchRead).toHaveBeenCalledTimes(1);
  expect(active).toEqual(originalActive);
  expect(manager.getEntries().slice(0, originalEntries.length)).toEqual(originalEntries);
  expect(readFileSync(record, "utf8")).toBe(diskBefore);

  const reopened = SessionManager.open(record, join(root, "sessions"), root);
  const resumed = customPictureContext(reopened)(reopened.buildSessionContext().messages);
  expect(resumed).toEqual(noticed);
  const next = reopened.appendMessage({
    role: "user",
    content: "Another comparison.",
    timestamp: 4,
  });
  reopened.appendCompaction("A later text summary.", next, 80);
  const later = customPictureContext(reopened)(reopened.buildSessionContext().messages);
  expect(later[0]).toMatchObject({
    role: "compactionSummary",
    summary: `A later text summary.\n\n${COMPACTED_PICTURES_NOTICE}`,
  });
  console.info(
    "CUSTOM_PICTURE_COMPACTION",
    JSON.stringify({
      originalPictureSaved: diskBefore.includes('"type":"image"'),
      activePictures: 0,
      notice: COMPACTED_PICTURES_NOTICE,
      resumeEqual: true,
      originalEntriesUnchanged: true,
    }),
  );
});

it("does not claim text-only compaction lost pictures", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Compare the text.", timestamp: 0 });
  const keep = manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
  manager.appendCompaction("Text summary.", keep, 20);
  const messages = manager.buildSessionContext().messages;
  expect(customPictureContext(manager)(messages)).toEqual(messages);
});
