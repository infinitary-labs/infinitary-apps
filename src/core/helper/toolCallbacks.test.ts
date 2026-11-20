import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLACED_COPY_CHUNK_BYTES, workRequests } from "@shared/work";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { HANDOVER_OUT_DIR_NAME } from "../tasks/handoverFiles";
import { PlacedTasks } from "./placedTasks";
import { type TaskAsks, toolCallbacks } from "./toolCallbacks";

const TASK = "task-handing";

describe("toolCallbacks", () => {
  // docs/helper.md, "Handed files": a computer that runs work sends each handed
  // file to its home over inf:work:handover-file in pieces, before the report.
  it("sends a report's handed file home in pieces before the report that names it", async () => {
    const tasks = new PlacedTasks(scratchDir("infinitary-tool-callbacks-"));
    const folders = tasks.ensure(TASK);
    // A bank statement the crewmate saved for another task, longer than one piece.
    const rows = ["date,description,amount,balance"];
    for (let day = 0; rows.length < 120_000; day++)
      rows.push(
        `2026-${String((day % 12) + 1).padStart(2, "0")}-${String((day % 28) + 1).padStart(2, "0")},Card payment ${day},-${(day % 97) + 0.5},${10_000 - (day % 5_000)}`,
      );
    const statement = Buffer.from(`${rows.join("\n")}\n`);
    expect(statement.length).toBeGreaterThan(PLACED_COPY_CHUNK_BYTES);
    const sha256 = createHash("sha256").update(statement).digest("hex");
    const handed = { file: `${sha256.slice(0, 16)}-statement.csv`, size: statement.length, sha256 };
    mkdirSync(join(folders.temp, HANDOVER_OUT_DIR_NAME), { recursive: true });
    writeFileSync(join(folders.temp, HANDOVER_OUT_DIR_NAME, handed.file), statement);

    const asked: { channel: string; fields: Record<string, unknown> }[] = [];
    const asks: TaskAsks = {
      task: TASK,
      call: async (channel, fields) => {
        asked.push({ channel, fields: fields as Record<string, unknown> });
        return channel === "inf:work:report" ? { text: "Report kept." } : { ok: true };
      },
      withDeadline: (_channel, run, toolSignal) => run(toolSignal ?? new AbortController().signal),
      log: () => {},
    };
    const callbacks = toolCallbacks(asks, folders, { tasks });

    const answer = await callbacks.onReport?.("Handed the statement on.", "Statement handed", {
      files: [handed],
    });

    expect(answer).toBe("Report kept.");
    expect(asked.at(-1)?.channel).toBe("inf:work:report");
    const report = workRequests["inf:work:report"].request.parse([
      { task: TASK, ...asked.at(-1)?.fields },
    ])[0];
    expect(report.declared?.files).toEqual([handed]);
    const pieces = asked.slice(0, -1).map(({ channel, fields }) => {
      expect(channel).toBe("inf:work:handover-file");
      return workRequests["inf:work:handover-file"].request.parse([{ task: TASK, ...fields }])[0];
    });
    expect(pieces).toHaveLength(Math.ceil(statement.length / PLACED_COPY_CHUNK_BYTES));
    let offset = 0;
    const received = pieces.map((piece) => {
      expect(piece).toMatchObject({ file: handed.file, size: handed.size, sha256, offset });
      const bytes = Buffer.from(piece.data, "base64");
      offset += bytes.length;
      return bytes;
    });
    expect(offset).toBe(statement.length);
    expect(createHash("sha256").update(Buffer.concat(received)).digest("hex")).toBe(sha256);
  });
});
