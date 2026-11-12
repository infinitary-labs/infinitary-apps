import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertInstallerEnvironment,
  installerAppEnvironment,
  installerServerEnvironment,
} from "../scripts/installer-environment.ts";
import { notarizeArtifact, recordNotarizationNetwork } from "../scripts/notarize.ts";
import { scratchDir } from "./helpers/scratchDirs";

// INF-816's approved repair: notarize once, keep the assigned submission after a
// drop, diagnose failures, and never use the physical Mac. Status/ID and transport
// readings below come from the failed signed runs, not from a local Apple account.
const id = "a198b486-b94c-46aa-b0c7-e15127ea5578";
const offline =
  'Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline." unsatisfied (No network route)';
const lost = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
const timedOut = 'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."';
const ok = (body: unknown = {}) => ({ status: 0, stdout: JSON.stringify(body), stderr: "" });
const failed = (stderr: string) => ({ status: 1, stdout: "", stderr });
const status = (value: string) => ok({ id, status: value });

type CommandResult = Awaited<ReturnType<Parameters<typeof notarizeArtifact>[1]["run"]>>;

function fixture(results: CommandResult[], uploads?: number) {
  const dir = scratchDir("inf-notary-recovery-");
  const upload = join(dir, "app.zip");
  // The archive's actual bytes are immaterial to the status protocol; hash a
  // real project file so the journal can detect replacement, not just its path.
  writeFileSync(upload, readFileSync("packaging/mac-installation.json"));
  const inputs = {
    upload,
    target: join(dir, "Infinitary.app"),
    journal: join(dir, "submission.json"),
  };
  const calls: string[][] = [];
  const snapshots: unknown[] = [];
  let clock = 0;
  const pause = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const run = vi.fn(
    (
      _command: string,
      args: string[],
      onStdout?: (chunk: string) => void,
    ): CommandResult | Promise<CommandResult> => {
      calls.push(args);
      snapshots.push(JSON.parse(readFileSync(inputs.journal, "utf8")));
      const result = results.shift();
      if (!result) throw new Error(`Unexpected request: ${args.slice(0, 2).join(" ")}`);
      // An upload's output streams as notarizationRunner streams it.
      if (args[1] === "submit") onStdout?.(result.stdout);
      return result;
    },
  );
  const recordNetwork = vi.fn();
  const effects = {
    run,
    pause,
    now: () => clock,
    recordNetwork,
    retryDelays: [15, 30],
    pollDelay: 30,
    waitBudget: 60,
    ...(uploads === undefined ? {} : { uploads }),
  };
  return {
    inputs,
    effects,
    calls,
    snapshots,
    results,
    run,
    recordNetwork,
    pause,
    read: () => JSON.parse(readFileSync(inputs.journal, "utf8")),
    check: () => notarizeArtifact(inputs, effects),
  };
}

describe("installer notarization recovery", () => {
  it("submits once, persists the ID before reads, and recovers status and ticket drops", async () => {
    const f = fixture([
      ok({ id }),
      failed(offline),
      status("In Progress"),
      failed(timedOut),
      status("Accepted"),
      failed(lost),
      ok(),
      ok(),
    ]);
    await expect(f.check()).resolves.toBe(id);
    expect(f.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "notarytool submit",
      "notarytool info",
      "notarytool info",
      "notarytool info",
      "notarytool info",
      "stapler staple",
      "stapler staple",
      "stapler validate",
    ]);
    for (const args of f.calls.filter((args) => args[1] === "info")) expect(args[2]).toBe(id);
    expect(f.snapshots[0]).toMatchObject({ phase: "submitting" });
    expect(f.snapshots[1]).toMatchObject({ phase: "submitted", id });
    expect(f.read()).toMatchObject({ id, phase: "validated", status: "Accepted" });
    expect(f.pause.mock.calls.flat()).toEqual([15, 30, 15, 15]);
    expect(f.recordNetwork.mock.calls.map((args) => args[0])).toEqual([
      "notarization status",
      "notarization status",
      "stapling",
    ]);
  });

  it("stops after exhausted transport retries, records the final failure, and resumes the same ID", async () => {
    const f = fixture([ok({ id }), failed(offline), failed(offline), failed(offline)]);
    await expect(f.check()).rejects.toThrow(id);
    expect(f.recordNetwork).toHaveBeenCalledTimes(3);
    expect(f.read()).toMatchObject({ phase: "submitted", id });
    f.results.push(status("Accepted"), ok(), ok());
    await f.check();
    expect(f.calls.filter((args) => args[1] === "submit")).toHaveLength(1);
    expect(f.read().phase).toBe("validated");
  });

  it("never reuploads an uncertain submission, including after a restart", async () => {
    const f = fixture([failed(offline)]);
    await expect(f.check()).rejects.toThrow("outcome is unknown");
    await expect(f.check()).rejects.toThrow("do not resubmit");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.recordNetwork).toHaveBeenCalledTimes(1);
  });

  it("keeps the recorded empty timed-out upload unknown and never submits it again", async () => {
    // Actual result retained in run 39874845604's installer-build-evidence.
    const result = {
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawnSync /usr/bin/xcrun ETIMEDOUT"),
    };
    const f = fixture([result]);
    await expect(f.check()).rejects.toThrow("outcome is unknown");
    await expect(f.check()).rejects.toThrow("do not resubmit");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.recordNetwork).toHaveBeenCalledWith("submit", 0, result);
    expect(f.read()).toMatchObject({ phase: "submitting" });
    expect(f.read().id).toBeUndefined();
  });

  it("uses an ID returned before a submit transport failure without another upload", async () => {
    const f = fixture([
      { ...failed(lost), stdout: JSON.stringify({ id }) },
      status("Accepted"),
      ok(),
      ok(),
    ]);
    await expect(f.check()).resolves.toBe(id);
    expect(f.calls.filter((args) => args[1] === "submit")).toHaveLength(1);
    expect(f.recordNetwork).toHaveBeenCalledWith(
      "submit",
      0,
      expect.objectContaining({ stderr: lost }),
    );
  });

  // INF-643 run 39874845604: JSON output withheld the ID until completion;
  // the local deadline killed submit with empty output. The normal-output ID
  // arrives before upload completion (run 39712112107, job 119605613318).
  it("persists a streamed submission ID before the upload command finishes", async () => {
    const f = fixture([status("Accepted"), ok(), ok()]);
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish!: (result: CommandResult) => void;
    const finished = new Promise<CommandResult>((resolve) => {
      finish = resolve;
    });
    const output = `Submission ID received\n  id: ${id}\n`;
    f.run.mockImplementationOnce(
      (_command: string, _args: string[], onStdout?: (chunk: string) => void) => {
        onStdout?.(output.slice(0, 30));
        onStdout?.(output.slice(30));
        start();
        return finished;
      },
    );
    const checked = f.check();
    await started;
    try {
      expect(f.read()).toMatchObject({ id, phase: "uploading" });
      expect(f.run).toHaveBeenCalledTimes(1);
      expect(f.run.mock.calls[0]?.[1].slice(-3)).toEqual([
        "--output-format",
        "normal",
        "--no-progress",
      ]);
    } finally {
      finish({ status: 0, stdout: output, stderr: "" });
      await checked.catch(() => {});
    }
    await expect(checked).resolves.toBe(id);
    expect(f.read()).toMatchObject({ id, status: "Accepted", phase: "validated" });
  });

  it("does not reuse a submission for changed bytes", async () => {
    const f = fixture([ok({ id }), status("Accepted"), ok(), ok()]);
    await f.check();
    writeFileSync(f.inputs.upload, readFileSync("packaging/release-source.json"));
    const previousCalls = f.run.mock.calls.length;
    await expect(f.check()).rejects.toThrow("another artifact");
    expect(f.run).toHaveBeenCalledTimes(previousCalls);
  });

  it("refuses rejection and authentication errors without retrying or stapling", async () => {
    const rejected = fixture([ok({ id }), status("Invalid")]);
    await expect(rejected.check()).rejects.toThrow("not accepted: Invalid");
    expect(rejected.calls).toHaveLength(2);
    expect(rejected.pause).not.toHaveBeenCalled();
    const unauthorized = fixture([ok({ id }), failed("HTTP status code: 401. Unauthorized.")]);
    await expect(unauthorized.check()).rejects.toThrow("401");
    expect(unauthorized.calls).toHaveLength(2);
    expect(unauthorized.pause).not.toHaveBeenCalled();
    expect(unauthorized.recordNetwork).toHaveBeenCalledTimes(1);
  });

  it("keeps an unfinished submission at the wait budget and preserves failure if diagnostics fail", async () => {
    const pending = fixture([
      ok({ id }),
      status("In Progress"),
      status("In Progress"),
      status("In Progress"),
    ]);
    await expect(pending.check()).rejects.toThrow("final outcome is unknown");
    expect(pending.read()).toMatchObject({ id, status: "In Progress" });
    const broken = fixture([ok({ id }), failed(offline), failed(offline), failed(offline)]);
    broken.recordNetwork.mockImplementation(() => {
      throw new Error("diagnostics unavailable");
    });
    await expect(broken.check()).rejects.toThrow("No network route");
  });
});

// The release's notarization (release.yml's app and disk image steps) uploads
// up to three times. Alpha run 43170881035, job 131026500441: Apple assigned
// the disk image a submission, then the upload broke off on a connect timeout
// and the bare `notarytool submit --wait` ended the release.
describe("release notarization", () => {
  const brokenOff = "7cb8517c-e1ac-435c-a45c-f3c87fa03fa2";
  const connectTimeout = {
    status: 1,
    stdout: `Conducting pre-submission checks for Infinitary-0.7.1-alpha.556-mac-universal.dmg and initiating connection to the Apple notary service...\nSubmission ID received\n  id: ${brokenOff}\n`,
    stderr: "Error: HTTPClientError.connectTimeout\n",
  };

  it("uploads again after alpha run 43170881035's broken-off upload and waits on the new submission", async () => {
    const f = fixture([connectTimeout, ok({ id }), status("Accepted"), ok(), ok()], 3);
    await expect(f.check()).resolves.toBe(id);
    expect(f.calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "notarytool submit",
      "notarytool submit",
      "notarytool info",
      "stapler staple",
      "stapler validate",
    ]);
    expect(f.calls[2]?.[2]).toBe(id);
    // The second upload starts from a fresh journal that keeps the first ID.
    expect(f.snapshots[1]).toMatchObject({ phase: "submitting", abandoned: [brokenOff] });
    expect(f.snapshots[1]).not.toHaveProperty("id");
    expect(f.read()).toMatchObject({ id, phase: "validated", abandoned: [brokenOff] });
    expect(f.recordNetwork).toHaveBeenCalledWith("submit", 0, connectTimeout);
    expect(f.pause.mock.calls.flat()).toEqual([15]);
  });

  // Apple's answer to an unregistered throwaway key, read on a Mac with
  // notarytool 1.1.3: an authentication refusal is never uploaded again.
  it("refuses Apple's authentication refusal at the upload without uploading again", async () => {
    const refused = {
      status: 1,
      stdout: "",
      stderr:
        "Error: HTTP status code: 401. Unauthenticated. Ensure that all authentication arguments are correct.\n",
    };
    const f = fixture([refused], 3);
    await expect(f.check()).rejects.toThrow("HTTP status code: 401. Unauthenticated.");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.pause).not.toHaveBeenCalled();
  });
});

it("retains each failed request and every network probe result even when a reading is unavailable", () => {
  const f = fixture([]);
  const probe = vi.fn(() => ({
    status: 1,
    stdout: "",
    stderr: "",
    error: new Error("read unavailable"),
  }));
  recordNotarizationNetwork(f.inputs.journal, "notarization status", 0, failed(offline), probe);
  recordNotarizationNetwork(f.inputs.journal, "notarization status", 1, failed(timedOut), probe);
  const rows = readFileSync(`${f.inputs.journal}.network.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => row.stderr)).toEqual([offline, timedOut]);
  expect(probe.mock.calls.slice(0, 3)).toEqual([
    ["/usr/sbin/scutil", ["--nwi"]],
    ["/sbin/route", ["-n", "get", "default"]],
    ["/usr/bin/pmset", ["-g", "assertions"]],
  ]);
  expect(rows[1].readings).toHaveLength(3);
  expect(
    rows[1].readings.every((reading: { error: string }) => reading.error === "read unavailable"),
  ).toBe(true);
});

describe("disposable installer environment", () => {
  // INF-643's fixture-only repair: the fused Node reader needs the system
  // store opt-in on first launch and restart. Node accepts exactly "1";
  // this tests environment wiring, not macOS trust or a signed installation.
  it("uses the same isolated system-trust opt-in for launch and restart without inheriting TLS bypasses", () => {
    const home = join(scratchDir("inf-installer-app-env-"), "home");
    const parent = {
      LANG: "en_US.UTF-8",
      HOME: "/ci/runner",
      PATH: "/opt/homebrew/bin:/usr/bin",
      NODE_USE_SYSTEM_CA: "true",
      NODE_EXTRA_CA_CERTS: "/ci/old-fixture.pem",
      NODE_OPTIONS: "--use-system-ca",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      APPLE_API_KEY: "/ci/signing/notary.p8",
      GITHUB_ACTIONS: "true",
    };
    const before = { ...parent };
    const { env, launch } = installerAppEnvironment(home, parent);
    expect(env).toMatchObject({
      HOME: home,
      CFFIXED_USER_HOME: home,
      LANG: parent.LANG,
      INFINITARY_LOCAL_CODESIGN_DIR: join(home, "local-codesign"),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NODE_USE_SYSTEM_CA: "1",
      PI_OFFLINE: "1",
    });
    expect(launch.NODE_USE_SYSTEM_CA).toBe("1");
    for (const [name, value] of Object.entries(launch)) expect(env[name]).toBe(value);
    for (const name of [
      "NODE_EXTRA_CA_CERTS",
      "NODE_OPTIONS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "APPLE_API_KEY",
      "GITHUB_ACTIONS",
    ])
      expect(env[name]).toBeUndefined();
    expect(parent).toEqual(before);
  });

  // INF-643 run 39907647383: both real Mac jobs passed admission, but their
  // fixture server inherited an app environment with the Actions facts removed.
  it.each(["github-hosted", "self-hosted"])(
    "passes actual %s runner facts only to the guarded fixture server",
    (runner) => {
      const home = join(scratchDir("inf-installer-server-env-"), "home");
      const appEnv = {
        HOME: home,
        CFFIXED_USER_HOME: home,
        INFINITARY_LOCAL_CODESIGN_DIR: join(home, "local-codesign"),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      };
      const parent = {
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: runner,
        APPLE_API_KEY: "/ci/temp/installer-signing/notary.p8",
        HOME: "/ci/runner",
      };
      const child = installerServerEnvironment(appEnv, parent);
      expect(() =>
        assertInstallerEnvironment({
          platform: "darwin",
          actions: child.GITHUB_ACTIONS,
          runner: child.RUNNER_ENVIRONMENT,
          virtual: () => ({ status: 0, stdout: "1\n" }),
        }),
      ).not.toThrow();
      expect(child.HOME).toBe(home);
      expect(child.CFFIXED_USER_HOME).toBe(home);
      expect(child.INFINITARY_LOCAL_CODESIGN_DIR).toBe(appEnv.INFINITARY_LOCAL_CODESIGN_DIR);
      expect(child.APPLE_API_KEY).toBeUndefined();
      expect(appEnv).not.toHaveProperty("GITHUB_ACTIONS");
      expect(appEnv).not.toHaveProperty("RUNNER_ENVIRONMENT");

      // A missing fact is not replaced with a successful hosted identity.
      const missing = installerServerEnvironment(child, {});
      expect(missing.GITHUB_ACTIONS).toBeUndefined();
      expect(missing.RUNNER_ENVIRONMENT).toBeUndefined();
      expect(() =>
        assertInstallerEnvironment({
          platform: "darwin",
          actions: missing.GITHUB_ACTIONS ?? "",
          runner: missing.RUNNER_ENVIRONMENT,
        }),
      ).toThrow("Actions Mac");
    },
  );

  it("accepts a hosted Mac or a confirmed Actions VM, but refuses a physical or unreadable self-hosted Mac", () => {
    const virtual = vi.fn(() => ({ status: 0, stdout: "1\n" }));
    const input = { platform: "darwin", actions: "true", runner: "github-hosted", virtual };
    expect(() => assertInstallerEnvironment(input)).not.toThrow();
    expect(virtual).not.toHaveBeenCalled();
    input.runner = "self-hosted";
    expect(() => assertInstallerEnvironment(input)).not.toThrow();
    virtual.mockReturnValue({ status: 0, stdout: "0\n" });
    expect(() => assertInstallerEnvironment(input)).toThrow("physical Mac");
    virtual.mockReturnValue({ status: 1, stdout: "" });
    expect(() => assertInstallerEnvironment(input)).toThrow("physical Mac");
    input.actions = "false";
    expect(() => assertInstallerEnvironment(input)).toThrow("Actions Mac");
  });
});
