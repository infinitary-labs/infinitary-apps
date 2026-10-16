import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import { questionSessionSpec } from "../decisions/questionSession";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID, type SessionSpec } from "../session/session";
import { resolveClaudeExecutable } from "./claudeCli";
import { MessageQueue, userMessage } from "./claudeQueryCore";
import { encodeClaudeProjectDir } from "./claudeTranscript";
import { claudeSessionOptions } from "./session";

// Measured on the hosted Linux check machine with four integration workers:
// slowest per-case minimum 2.060 s; five times, rounded up to 5 s.
vi.setConfig({ testTimeout: 15_000 });

/**
 * The person's own Claude notes never reach a session the app opens
 * (FI3-795), on the client the product would run - the override, else the
 * installed one, else the SDK's own copy - boxed by the e2e stub
 * (`tests/e2e/mockClaudeClient.ts` turn mode) with the options the app opens
 * each shape with (`claudeSessionOptions`).
 *
 * Left to itself the client keeps notes per project in the Claude folder,
 * under `projects/<the working copy's path>/memory/` with `MEMORY.md` as
 * their index, serves that index to every session started there and tells
 * the model to write more. That folder is the person's own Claude setup,
 * which `settingSources: []` does not reach, so the app turns the client's
 * auto memory off for every session.
 *
 * Each case plants an index where the client looks for the session's working
 * copy, runs one turn, and reads every request the client sent: neither the
 * planted note nor the notes folder reaches the model. A control proves the
 * plant is where the client looks: with the switch taken out, the note
 * reaches the model.
 */

const MODEL = "claude-haiku-4-5";

/** What the planted index says; never anything a session of the app's should read. */
const PLANTED = "planted-claude-note-the-app-never-serves";

let api: StubApi;

beforeAll(async () => {
  // Every request the client sends is kept, its housekeeping included.
  api = await startStubApi(() => true);
});

afterAll(async () => {
  await api.close();
});

/**
 * The client's notes folders for a working copy: one per spelling of its
 * path (macOS answers a temporary folder through a symlink), each in the
 * project folder the client keeps its transcripts in.
 */
function notesFolders(configDir: string, cwd: string): string[] {
  return [...new Set([cwd, realpathSync(cwd)])].map((path) =>
    join(configDir, "projects", encodeClaudeProjectDir(path), "memory"),
  );
}

/** One note and its index, the way the client writes them. */
function plantNotes(folder: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "MEMORY.md"), `- [Planted note](planted.md) - ${PLANTED}\n`);
  writeFileSync(
    join(folder, "planted.md"),
    `---\nname: planted\ndescription: ${PLANTED}\nmetadata:\n  type: project\n---\n\n${PLANTED}\n`,
  );
}

type Shape = "crewmate" | "seat" | "question";

/**
 * A session of the given shape in a box of its own: a throwaway HOME holding
 * the boxed client and its config folder, a working copy outside it, and
 * notes planted where the client would look for that working copy.
 */
function boxed(shape: Shape) {
  const home = scratchDir("infinitary-claude-notes-home-");
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, maxRetries: 0, ...(client ? { client } : {}) },
  });
  const cwd = join(scratchDir("infinitary-claude-notes-work-"), "repo");
  mkdirSync(cwd, { recursive: true });
  // The boxed client's config folder (the stub's CLAUDE_CONFIG_DIR).
  const folders = notesFolders(join(home, ".claude"), cwd);
  for (const folder of folders) plantNotes(folder);
  const binding = { backend: "claude" as const, accountId: "acct_claude_notes" };
  const spec: SessionSpec =
    shape === "crewmate"
      ? crewmateSessionSpec(
          appPathsFor(scratchDir("infinitary-claude-notes-app-")),
          { ...crewmateToolDelegate(), machineId: LOCAL_MACHINE_ID, cwd },
          binding,
        )
      : shape === "seat"
        ? seatSpec({
            cwd,
            sessionsDir: join(home, "firstmate", "sessions"),
            binding,
            model: { provider: "anthropic-claude", id: MODEL },
            tools: [],
          })
        : questionSessionSpec({
            homeDir: cwd,
            binding,
            model: { provider: "anthropic-claude", id: MODEL },
            instruction: "Answer with exactly one of: left, right.",
          });
  /**
   * What the app hands the SDK for this session, over a boxed host
   * environment whose shell forces the client's auto memory on, as a person
   * may: the app's switch still wins.
   */
  const options = (): Options =>
    claudeSessionOptions({
      spec,
      env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" },
      executable: stub,
      stderr: () => {},
      ...(spec.shape.turns === "rolling"
        ? { attachment: { model: MODEL, session: { sessionId: randomUUID() } } }
        : {}),
    });
  return { folders, options };
}

/** The same options with the client's auto memory left to its own default. */
function withClientDefault(options: Options): Options {
  const env = { ...options.env };
  delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  return { ...options, env };
}

/** Everything the client sent while a session with these options ran one turn. */
async function served(options: Options): Promise<string> {
  const from = api.requests.length;
  const input = new MessageQueue();
  const session = query({ prompt: input, options });
  input.push(userMessage("What do you know about this project?"));
  for await (const message of session) {
    // The client exits once its input ends; the session ends with it.
    if (message.type === "result") input.close();
  }
  return api.requests
    .slice(from)
    .map((request) => request.raw)
    .join("\n");
}

describe("the person's Claude notes and a session the app opens", () => {
  for (const shape of ["crewmate", "seat", "question"] as const) {
    it(`serves the ${shape} none of the notes, nor where they are kept`, async () => {
      const box = boxed(shape);
      const sent = await served(box.options());
      expect(sent, "the client sent the turn").toContain("What do you know about this project?");
      expect(sent, "a planted note reached the model").not.toContain(PLANTED);
      for (const folder of box.folders) {
        expect(sent, "the notes folder reached the model").not.toContain(folder);
      }
    });

    it(`would serve the ${shape} the planted note were the client left to its default`, async () => {
      const box = boxed(shape);
      const sent = await served(withClientDefault(box.options()));
      expect(sent, "the note sits where the client looks").toContain(PLANTED);
    });
  }
});
