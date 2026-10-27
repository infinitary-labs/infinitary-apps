import {
  type ChildProcessByStdio,
  spawn,
  type SpawnOptionsWithStdioTuple,
  spawnSync,
} from "node:child_process";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInstallerEnvironment } from "./installer-environment.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

// Recorded transport failures from INF-816. A rejection or an authentication error
// is not a network drop and must never become a successful verification.
type Result = { status: number | null; stdout: string; stderr: string; error?: Error };
type State = {
  upload: string;
  target: string;
  sha256: string;
  phase: string;
  id?: string;
  status?: string;
};
type Command = (
  command: string,
  args: string[],
  onStdout?: (chunk: string) => void,
) => Result | Promise<Result>;
type Effects = {
  run: Command;
  pause: (ms: number) => Promise<void>;
  now: () => number;
  recordNetwork: (name: string, attempt: number, result: Result) => void;
  auth?: string[];
  retryDelays?: number[];
  pollDelay?: number;
  waitBudget?: number;
};
const networkFailure = (result: Result) =>
  /NSURLErrorDomain[^\n]*Code=-(1001|1005|1009)\b/.test(`${result.stdout}\n${result.stderr}`);
const submissionId = (id: unknown): id is string =>
  typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);

type StartCommand = (
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">,
) => ChildProcessByStdio<null, Readable, Readable>;

// A submit includes the whole archive upload, not just a status request.
// Its bound is the enclosing Actions job, not the short read-command deadline.
// Stream normal output: notarytool buffers JSON until the operation finishes.
export function notarizationRunner(env: NodeJS.ProcessEnv, start: StartCommand = spawn): Command {
  return (command, args, onStdout) => {
    if (args[0] !== "notarytool" || args[1] !== "submit")
      return spawnSync(command, args, { env, encoding: "utf8", timeout: 120_000 });
    return new Promise<Result>((resolve, reject) => {
      const child = start(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let error: Error | undefined;
      let observerError: unknown;
      let observerFailed = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (observerFailed) return;
        try {
          onStdout?.(chunk);
        } catch (cause) {
          // Never continue an upload if its ID cannot be saved. Wait for close
          // before returning the original journal failure to the caller.
          observerFailed = true;
          observerError = cause;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (cause) => {
        error = cause;
      });
      child.on("close", (status) => {
        if (observerFailed) reject(observerError);
        else resolve({ status, stdout, stderr, error });
      });
    });
  };
}

// The caller supplies effects so tests can replay actual Apple readings without
// accessing signing material or waiting on a network. The journal is written
// before submit: an uncertain submission is never uploaded a second time.
export async function notarizeArtifact(
  { upload, target, journal }: { upload: string; target: string; journal: string },
  {
    run,
    pause,
    now,
    recordNetwork,
    auth = [],
    retryDelays = [15_000, 30_000, 60_000, 60_000, 60_000],
    pollDelay = 30_000,
    waitBudget = 30 * 60_000,
  }: Effects,
) {
  const save = (state: State) => {
    writeFileSync(`${journal}.pending`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${journal}.pending`, journal);
  };
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const acceptedResult = (result: Result) => !result.error && result.status === 0;
  async function request(args: string[], name: string) {
    for (let attempt = 0; ; attempt++) {
      const result = await run("/usr/bin/xcrun", args);
      if (acceptedResult(result)) return result;
      // Record the network at failure time, not after a retry changes the state.
      // This observer must not replace the original failure.
      try {
        recordNetwork(name, attempt, result);
      } catch {
        /* retain original outcome */
      }
      if (!networkFailure(result) || attempt === retryDelays.length)
        fail(
          `${name} failed${submissionId(state.id) ? ` for submission ${state.id}` : ""}: ${result.stderr || result.stdout || result.error?.message || result.status}`,
        );
      await pause(retryDelays[attempt]!);
    }
  }
  mkdirSync(dirname(journal), { recursive: true });
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(upload)) digest.update(bytes);
  const sha256 = digest.digest("hex");
  let state: State;
  if (existsSync(journal)) {
    state = JSON.parse(readFileSync(journal, "utf8"));
    if (
      state.upload !== upload ||
      state.target !== target ||
      state.sha256 !== sha256 ||
      !submissionId(state.id)
    )
      fail(
        "The existing submission is uncertain or belongs to another artifact; do not resubmit it.",
      );
  } else {
    state = { upload, target, sha256, phase: "submitting" };
    save(state);
    // Do not retry this effect, even for a network error. Without an ID we do
    // not know whether Apple received it; the saved journal makes that explicit.
    const rememberId = (id: unknown) => {
      if (!submissionId(id)) return;
      if (state.id && state.id !== id) fail("Apple returned a different submission ID.");
      if (state.id === id) return;
      state = { ...state, id, phase: "uploading" };
      save(state);
    };
    let pending = "";
    const capture = (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) rememberId(/^\s*id:\s+(\S+)\s*$/.exec(line)?.[1]);
    };
    const result = await run(
      "/usr/bin/xcrun",
      ["notarytool", "submit", upload, ...auth, "--output-format", "normal", "--no-progress"],
      capture,
    );
    capture("\n");
    // A non-streaming caller can still supply the original structured reading.
    let response;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      /* normal output, or an uncertain response */
    }
    rememberId(response?.id);
    if (submissionId(state.id)) {
      state = { ...state, phase: acceptedResult(result) ? "submitted" : "uploading" };
      save(state);
    }
    if (!submissionId(state.id)) {
      try {
        recordNetwork("submit", 0, result);
      } catch {
        /* retain uncertainty */
      }
      fail(
        "No submission ID was confirmed; the upload outcome is unknown. Do not resubmit this artifact.",
      );
    }
    // A returned ID is enough to resume reading the same submission, even if
    // the upload command lost its connection after Apple assigned that ID.
    if (!acceptedResult(result)) {
      try {
        recordNetwork("submit", 0, result);
      } catch {
        /* retain submission ID */
      }
      if (!networkFailure(result))
        fail(
          `Submission ${state.id} failed: ${result.stderr || result.error?.message || result.status}`,
        );
    }
  }
  const deadline = now() + waitBudget;
  for (;;) {
    const result = await request(
      ["notarytool", "info", state.id!, ...auth, "--output-format", "json"],
      "notarization status",
    );
    const response = JSON.parse(result.stdout);
    if (response.id !== state.id) fail("Apple returned a different submission ID.");
    state = { ...state, status: response.status, phase: "waiting" };
    save(state);
    if (response.status === "Accepted") break;
    if (response.status !== "In Progress")
      fail(`Submission ${state.id} was not accepted: ${response.status}`);
    if (now() >= deadline)
      fail(`Submission ${state.id} is still in progress; its final outcome is unknown.`);
    await pause(pollDelay);
  }
  // Attaching a ticket to the same local copy is idempotent, unlike submitting.
  await request(["stapler", "staple", target], "stapling");
  await request(["stapler", "validate", target], "ticket validation");
  state = { ...state, phase: "validated" };
  save(state);
  return state.id;
}

export function recordNotarizationNetwork(
  journal: string,
  operation: string,
  attempt: number,
  result: Result,
  probe: (command: string, args: string[]) => Result,
) {
  const probes: [string, string[]][] = [
    ["/usr/sbin/scutil", ["--nwi"]],
    ["/sbin/route", ["-n", "get", "default"]],
    ["/usr/bin/pmset", ["-g", "assertions"]],
  ];
  const readings = probes.map(([command, args]) => {
    const reading = probe(command, args);
    return {
      command,
      status: reading.status,
      stdout: reading.stdout,
      stderr: reading.stderr,
      error: reading.error?.message,
    };
  });
  appendFileSync(
    `${journal}.network.jsonl`,
    `${JSON.stringify({
      time: new Date().toISOString(),
      operation,
      attempt,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
      readings,
    })}\n`,
    { mode: 0o600 },
  );
  console.log(`Recorded network state for ${operation}, attempt ${attempt + 1}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertInstallerEnvironment();
  const [upload, target, journal] = process.argv.slice(2);
  if (!upload || !target || !journal)
    throw new Error("Use <upload.zip|dmg> <target.app|dmg> <journal.json>.");
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer)
    throw new Error("The notarization credentials are not configured.");
  const auth = ["--key", key, "--key-id", keyId, "--issuer", issuer];
  const modules = await openModuleRunner();
  try {
    const { hostEnv } = await modules.import<typeof import("../src/core/hostEnv")>(
      join(REPO_ROOT, "src/core/hostEnv.ts"),
    );
    const env = hostEnv();
    await notarizeArtifact(
      { upload, target, journal },
      {
        run: notarizationRunner(env),
        auth,
        recordNetwork: (operation, attempt, result) =>
          recordNotarizationNetwork(journal, operation, attempt, result, (command, args) =>
            spawnSync(command, args, { env, encoding: "utf8", timeout: 10_000 }),
          ),
        now: Date.now,
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
  } finally {
    await modules.close();
  }
  console.log("Notarization accepted and ticket validated.");
}
