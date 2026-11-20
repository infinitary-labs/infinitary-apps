/**
 * @journey-area src/core/pi/bedrock.ts
 * @journey-area src/core/claude/claudeAccess.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { FIRSTMATE_PERSONA, KIND_CLASSIFIER_OPENING } from "../../../src/core/pi/piResources";
import { STARTER_SLOTS } from "../../../src/shared/modelSlots";
import { BEDROCK_PROVIDER_ID } from "../../../src/shared/providers";
import { scratchDir } from "../../helpers/scratchDirs";
import {
  seedAccountAuth,
  seedAccountRegistry,
  seedAccountRoot,
  seedAccountStore,
} from "../accountFixtures";
import { isReplyCheck, type Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

export const PLACED_CLAUDE_CONTROL_PROMPT = "Review the placed Claude environment fixture.";
export const PLACED_CLAUDE_CONTROL_REPORT = "The placed Claude environment review is complete.";

/** The ambient control reports once and closes its turn without waiting for a steer. */
export const placedClaudeControl: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream || !body.includes(PLACED_CLAUDE_CONTROL_PROMPT)) return;
    if (calledTool(body, "report") || latestUserTail.includes(PLACED_CLAUDE_CONTROL_REPORT))
      return { text: "done" };
    return { calls: [{ name: "report", args: { text: PLACED_CLAUDE_CONTROL_REPORT } }] };
  };

export const BEDROCK_MODEL =
  Object.entries(STARTER_SLOTS[BEDROCK_PROVIDER_ID] ?? {}).find(
    ([id, slots]) => id.startsWith("us.") && slots.includes("medium"),
  )?.[0] ?? "";
export const BEDROCK_CREW_WORDS = "Ask the Bedrock crew to review this fixture.";
export const BEDROCK_CREW_TITLE = "Bedrock role check";
export const BEDROCK_REPLY = "Bedrock answered this turn.";
export const BEDROCK_KEY = "disposable-bedrock-key";
export const BEDROCK_PROFILE = "hermetic-bedrock";
export const PROFILE_KEY_ID = "AKIDBEDROCKJOURNEY";

export const ROTATED_PROFILE_KEY_ID = "AKIDBEDROCKROTATED";
const RECOVERED_PROFILE_KEY_ID = "AKIDBEDROCKRECOVERED";
export const RECOVERED_BEDROCK_MODEL =
  Object.entries(STARTER_SLOTS[BEDROCK_PROVIDER_ID] ?? {}).find(
    ([id, slots]) => id.startsWith("us.") && slots.includes("high"),
  )?.[0] ?? "";

export const DENIED_BEDROCK_MODEL =
  Object.entries(STARTER_SLOTS[BEDROCK_PROVIDER_ID] ?? {}).find(
    ([id, slots]) => id.startsWith("us.") && slots.includes("low"),
  )?.[0] ?? "";
export const BEDROCK_CREW_RESULT = "The fixture review is complete.";
export const SHARED_BEDROCK_ROWS = [
  { id: "acct_bedrock_primary", region: "us-west-2" },
  { id: "acct_bedrock_restored", region: "us-east-1" },
  { id: "acct_bedrock_denied", region: "us-east-2" },
] as const;

export function seedSharedBedrockRows(userDataDir: string): void {
  const now = Date.now();
  seedAccountRoot(userDataDir);
  seedAccountRegistry(
    userDataDir,
    SHARED_BEDROCK_ROWS.map(({ id, region }) => ({
      id,
      providerId: BEDROCK_PROVIDER_ID,
      label: region,
      enabled: true,
      kind: "api_key",
      createdAt: now,
      ...(region === "us-east-2"
        ? {}
        : { cutOff: { class: "signed_out" as const, since: now, stamp: {} } }),
    })),
  );
  for (const { id, region } of SHARED_BEDROCK_ROWS) {
    seedAccountStore(userDataDir, BEDROCK_PROVIDER_ID, id);
    seedAccountAuth(userDataDir, BEDROCK_PROVIDER_ID, id, {
      [BEDROCK_PROVIDER_ID]: {
        type: "api_key",
        env: {
          AWS_PROFILE: BEDROCK_PROFILE,
          AWS_REGION: region,
          INFINITARY_BEDROCK_MODELS: region === "us-east-2" ? DENIED_BEDROCK_MODEL : BEDROCK_MODEL,
        },
      },
    });
  }
}

export function bedrockLoginExecutable(): string {
  const bin = scratchDir("bedrock-aws-cli-");
  const executable = join(bin, "aws");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$1 $2 $3" in
  "--version  ") echo aws-cli/2.fixture ;;
  "configure get sso_session") echo fixture ;;
  "sso login --no-browser")
    printf 'https://example.awsapps.com/start/#/device\nABCD-1234\n'
    printf '[${BEDROCK_PROFILE}]\naws_access_key_id=${RECOVERED_PROFILE_KEY_ID}\naws_secret_access_key=disposable-profile-secret\n' > "$HOME/.aws/credentials" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  return executable;
}

/** A policy file private to this worker and a witness of the real child environment. */
export function placedClaudeBedrockFixture(client: string) {
  const dir = scratchDir("placed-claude-bedrock-");
  const policy = join(dir, "managed-settings.json");
  const witness = join(dir, "child-env.jsonl");
  const wrapper = join(dir, "claude");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--input-format') && args.some(arg => arg.startsWith('--session-id=') || arg.startsWith('--resume='))) {
  const names = Object.keys(process.env).filter(name => /^AWS_/i.test(name) || name === 'CLAUDE_CODE_USE_BEDROCK');
  appendFileSync(${JSON.stringify(witness)}, JSON.stringify(names) + '\\n');
}
const child = spawn(${JSON.stringify(client)}, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  const setManaged = (mode: "off" | "bedrock" | "unreadable-helper") =>
    writeFileSync(
      policy,
      JSON.stringify(
        mode === "bedrock"
          ? { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }
          : mode === "unreadable-helper"
            ? { policyHelper: { path: join(dir, "missing-policy-helper") } }
            : {},
      ),
    );
  setManaged("off");
  return {
    env: {
      INFINITARY_CLAUDE_CLI: wrapper,
      INFINITARY_PLACED_CLAUDE_POLICY_FIXTURE: policy,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "ambient",
      AWS_BEARER_TOKEN_BEDROCK: "disposable-ambient",
    },
    setManaged,
    launches: () =>
      existsSync(witness)
        ? readFileSync(witness, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

export function installBedrockProfile(home: string, keyId = PROFILE_KEY_ID): void {
  const aws = join(home, ".aws");
  mkdirSync(aws, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(aws, "credentials"),
    `[${BEDROCK_PROFILE}]\naws_access_key_id=${keyId}\naws_secret_access_key=disposable-profile-secret\n`,
    { mode: 0o600 },
  );
}

export function removeBedrockProfile(home: string): void {
  rmSync(join(home, ".aws", "credentials"));
}

/** The AWS event-stream wire format exercises the shipped SDK, not a replacement driver. */
function event(name: string, fields: object): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ":event-type": name,
      ":message-type": "event",
      ":content-type": "application/json",
    }).map(([key, value]) =>
      Buffer.concat([
        Buffer.from([key.length]),
        Buffer.from(key),
        Buffer.from([7, 0, value.length]),
        Buffer.from(value),
      ]),
    ),
  );
  const body = Buffer.from(JSON.stringify(fields));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

export const BEDROCK_FIXTURE_USAGE = { inputTokens: 5000, outputTokens: 500, totalTokens: 5500 };

type BedrockFixtureRole = "reply-check" | "decision" | "firstmate" | "crew";

export async function startBedrockStandIn() {
  const inferenceResponses: Array<{
    request: number;
    role: BedrockFixtureRole;
    model: string;
    tool: string | null;
    maxTokens: number | undefined;
    at: number;
    finishedAt?: number;
    closedAt?: number;
  }> = [];
  let nextRefusal:
    | "ExpiredTokenException"
    | "ThrottlingException"
    | "AccessDeniedException"
    | "bare-403"
    | undefined;
  let pauseRechecks: Promise<void> | undefined;
  let resumeRechecks: (() => void) | undefined;
  let onRefusal: (() => void) | undefined;
  let acceptedProfile = PROFILE_KEY_ID;
  let allowedModels = new Map<string, string>([["us-west-2", BEDROCK_MODEL]]);
  const calls: Array<{
    model: string;
    check: boolean;
    role: BedrockFixtureRole;
    signed: boolean;
    profileId?: string;
    region?: string;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const payload = JSON.parse(body) as {
      inferenceConfig?: { maxTokens?: number };
    };
    const receivedAt = Date.now();
    const model = decodeURIComponent(request.url?.split("/")[2] ?? "");
    const check = payload.inferenceConfig?.maxTokens === 1;
    const authorization = request.headers.authorization ?? "";
    const profileId = /^AWS4-HMAC-SHA256 Credential=([^/]+)\//.exec(authorization)?.[1];
    const region = /\/\d{8}\/([^/]+)\/bedrock\//.exec(authorization)?.[1];
    const signed =
      authorization === `Bearer ${BEDROCK_KEY}` ||
      (profileId === acceptedProfile && region !== undefined);
    // Reply checks carry the captain's words as data, not as a work request.
    const role = isReplyCheck(body)
      ? "reply-check"
      : body.includes(KIND_CLASSIFIER_OPENING)
        ? "decision"
        : body.includes(FIRSTMATE_PERSONA)
          ? "firstmate"
          : "crew";
    const requestNumber = calls.push({ model, check, signed, profileId, region, role });
    if (check && pauseRechecks) await pauseRechecks;
    const refusal = !signed
      ? "UnrecognizedClientException"
      : model !== allowedModels.get(region ?? "us-west-2")
        ? "AccessDeniedException"
        : check
          ? undefined
          : nextRefusal;
    if (refusal) {
      if (!check && onRefusal) {
        const rotate = onRefusal;
        onRefusal = undefined;
        nextRefusal = undefined;
        rotate();
      }
      response.writeHead(refusal === "ThrottlingException" ? 429 : 403, {
        "content-type": "application/json",
        ...(refusal === "bare-403" ? {} : { "x-amzn-errortype": refusal }),
      });
      response.end(JSON.stringify({ message: refusal }));
      return;
    }
    response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    const spawn =
      role === "firstmate" && body.includes(BEDROCK_CREW_WORDS) && !body.includes("toolUseId");
    const report =
      !check && role === "crew" && body.includes(BEDROCK_CREW_WORDS) && !body.includes("toolUseId");
    const tool = spawn
      ? {
          name: "spawn_crewmate",
          args: {
            title: BEDROCK_CREW_TITLE,
            goal: "Review the supplied fixture.",
            user_words: BEDROCK_CREW_WORDS,
            constraints: [{ kind: "read-only" }],
            shape: { rigor_ask: "quick" },
          },
        }
      : report
        ? { name: "report", args: { text: BEDROCK_CREW_RESULT } }
        : undefined;
    const answer =
      role === "reply-check" ? "ordinary" : role === "decision" ? "research" : BEDROCK_REPLY;
    const deltas = tool
      ? [
          event("contentBlockStart", {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "fixtureTool", name: tool.name } },
          }),
          event("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { toolUse: { input: JSON.stringify(tool.args) } },
          }),
        ]
      : [
          event("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { text: answer },
          }),
        ];
    if (!check) {
      const inference: (typeof inferenceResponses)[number] = {
        request: requestNumber,
        role,
        model,
        tool: tool?.name ?? null,
        maxTokens: payload.inferenceConfig?.maxTokens,
        at: receivedAt,
      };
      inferenceResponses.push(inference);
      response.once("finish", () => {
        inference.finishedAt = Date.now();
      });
      response.once("close", () => {
        inference.closedAt = Date.now();
      });
    }
    response.end(
      Buffer.concat([
        event("messageStart", { role: "assistant" }),
        ...deltas,
        event("contentBlockStop", { contentBlockIndex: 0 }),
        event("messageStop", { stopReason: tool ? "tool_use" : "end_turn" }),
        event("metadata", {
          usage: BEDROCK_FIXTURE_USAGE,
          metrics: { latencyMs: 1 },
        }),
      ]),
    );
  });
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    inferenceResponses,
    servedInference: () => inferenceResponses.length,
    refuse(code: typeof nextRefusal) {
      nextRefusal = code;
    },
    afterExplicitRecovery(model?: string) {
      acceptedProfile = RECOVERED_PROFILE_KEY_ID;
      allowedModels = new Map(model ? [["us-west-2", model]] : []);
    },
    pauseRechecks() {
      pauseRechecks = new Promise<void>((resolve) => {
        resumeRechecks = resolve;
      });
      return () => {
        pauseRechecks = undefined;
        resumeRechecks?.();
      };
    },
    afterSharedRecovery() {
      acceptedProfile = RECOVERED_PROFILE_KEY_ID;
      allowedModels = new Map([
        ["us-west-2", BEDROCK_MODEL],
        ["us-east-1", RECOVERED_BEDROCK_MODEL],
      ]);
    },
    requireProfileRotation(home: string) {
      nextRefusal = "ExpiredTokenException";
      onRefusal = () => {
        installBedrockProfile(home, ROTATED_PROFILE_KEY_ID);
        acceptedProfile = ROTATED_PROFILE_KEY_ID;
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        resumeRechecks?.();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
