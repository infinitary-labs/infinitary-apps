import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { fakeBinding } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  appPathsFor,
  crewmateCardBodiesDir,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
} from "../paths";
import { localTimeZoneName, timeZoneFact } from "../prompts/timeZone";
import { LOCAL_MACHINE_ID } from "../session/session";
import { crewmateContractStamp, crewmateRestartText, crewmateSessionSpec } from "./crewSession";

it.each(["pi", "claude"] as const)(
  "a %s session carries the editable body folder to its instructions and tools",
  async (backend) => {
    const root = scratchDir("crew-card-file-");
    const paths = appPathsFor(root);
    const dir = scratchDir("crew-card-bodies-");
    const body = "<p>A file snapshot from this session.</p>";
    await writeFile(join(dir, "answer.html"), body);
    const shown: string[] = [];
    const session = crewmateSessionSpec(
      paths,
      {
        machineId: LOCAL_MACHINE_ID,
        taskId: "task-1",
        cwd: root,
        evidenceDir: crewmateEvidenceDir(paths, "task-1"),
        cardBodiesDir: dir,
        onCard: (card) => {
          shown.push(card.body);
          return "card-task-1-answer";
        },
      },
      backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
    );
    expect(session.instructions.base).toContain(`Your card body folder is ${dir}`);
    const emit = session.tools.find((t) => t.name === "emit_card");
    expect(emit).toBeDefined();
    await emit?.run({ title: "Answer", body_file: "answer.html" });
    expect(shown).toEqual([body]);
    expect(crewmateCardBodiesDir(paths, "task-1")).toBe(
      join(paths.crewmatesDir, "task-1", "card-bodies"),
    );
    expect(crewmateCardBodiesDir(paths, "task-1")).not.toBe(
      crewmateCardPicturesDir(paths, "task-1"),
    );
  },
);

it.each(["pi", "claude"] as const)(
  "a %s session names the captain's local time zone for its time rule (FI3-1006)",
  (backend) => {
    const root = scratchDir("crew-time-zone-");
    const session = crewmateSessionSpec(
      appPathsFor(root),
      { machineId: LOCAL_MACHINE_ID, taskId: "task-1", cwd: root },
      backend === "pi" ? fakeBinding("test-account") : { backend, accountId: "test-account" },
    );
    const named = /The captain's local time zone is (\S+) \((UTC[+-]\d{2}:\d{2})\)\./.exec(
      session.instructions.base,
    );
    expect(named?.[1]).toBe(localTimeZoneName());
    expect(`${named?.[1]} (${named?.[2]})`).toBe(timeZoneFact(Date.now()));
  },
);

it("stamps a crewmate's conversation with the prompt and tools it serves, the same at every open of the same build", () => {
  const root = scratchDir("crew-contract-");
  const paths = appPathsFor(root);
  const { calls: _calls, ...every } = crewmateToolDelegate();
  const open = (delegate: Partial<typeof every> = every) =>
    crewmateSessionSpec(
      paths,
      {
        ...delegate,
        machineId: LOCAL_MACHINE_ID,
        taskId: "task-1",
        cwd: root,
        evidenceDir: crewmateEvidenceDir(paths, "task-1"),
      },
      { backend: "claude", accountId: "acct_claude" },
    );
  const stampOf = (spec: ReturnType<typeof open>) =>
    spec.shape.turns === "rolling" ? spec.shape.record.stamp : undefined;
  const first = open();
  const stamp = stampOf(first);
  expect(stamp).toEqual(crewmateContractStamp(first.instructions.base, first.tools));
  // Each tool the conversation is offered has its own sha.
  expect(Object.keys(stamp?.tools ?? {})).toEqual(first.tools.map((tool) => tool.name));
  // A reopen of the same task on the same build serves the same contract.
  expect(stampOf(open())).toEqual(stamp);
  // A task that loses a tool keeps the shas of the tools it still has.
  const { onOpenChange: _openChange, ...fewer } = every;
  const shrunk = stampOf(open(fewer));
  expect(shrunk?.tools?.open_change).toBeUndefined();
  expect(stamp?.tools?.open_change).toBeDefined();
  for (const [name, sha] of Object.entries(shrunk?.tools ?? {})) {
    expect(stamp?.tools?.[name]).toBe(sha);
  }
  // Changed words move the prompt's sha and the changed tool's own.
  const reworded = first.tools.map((tool) =>
    tool.name === "emit_card" ? { ...tool, description: `${tool.description} Reworded.` } : tool,
  );
  const changed = crewmateContractStamp(`${first.instructions.base} Reworded.`, reworded);
  expect(changed.promptSha).not.toBe(stamp?.promptSha);
  expect(changed.tools?.emit_card).not.toBe(stamp?.tools?.emit_card);
  expect(changed.tools?.report).toBe(stamp?.tools?.report);
});

it("tells a crewmate in a new conversation why, where its record is, and its brief", () => {
  const renewed = crewmateRestartText({
    restart: { from: "old-conversation", changed: ["prompt"] },
    taskKey: "FI3-7",
    brief: "Goal: count the rivets.",
    earlier: "/records/old-conversation.jsonl",
  });
  const [why, record, brief, next] = renewed.split("\n\n");
  expect(why).toContain("the app was updated");
  expect(record).toContain("tasks (key FI3-7)");
  expect(record).toContain("/records/old-conversation.jsonl");
  expect(brief).toBe("Your task's brief, as you first received it:");
  expect(renewed).toContain("Goal: count the rivets.");
  expect(next).toBe("Goal: count the rivets.");
  expect(renewed.endsWith("The message that brought you back follows.")).toBe(true);
  // Each cause names itself; a record without a brief or a saved copy says less.
  const personal = crewmateRestartText({
    restart: { from: "old", changed: ["instructions"] },
    taskKey: "FI3-7",
  });
  expect(personal).toContain("this computer's own instructions and skills changed");
  expect(personal).not.toContain("brief, as you first received it");
  expect(personal).not.toContain("transcript of your earlier conversation");
  const unopenable = crewmateRestartText({
    restart: { from: "old", changed: "unopenable" },
    taskKey: "FI3-7",
  });
  expect(unopenable).toContain("could not be reopened");
});
