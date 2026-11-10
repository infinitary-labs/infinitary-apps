import { execFile, execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import * as files from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import { decisionMessage, type FreshAuthentication } from "./approvals";
import { RootKeys, sha256 } from "./custody";
import { ProtectedSecrets, type ProtectedSecretsOptions } from "./protected";
import type { RecoveryFiles } from "./recoveryArchive";
import { openSecretHome } from "./recoveryHome";
import { type Injection, SECRET_REQUEST_LIFETIME_MS, SecretRequests } from "./requests";
import { SecretVault } from "./vault";

// This integration file is isolated. Keep every real filesystem operation;
// make its exports observable so the launch test can hold one completed open.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
afterEach(() => vi.restoreAllMocks());

// Intent: INF-1105 - the protected owner behind INF-30's coordinator: exact
// recipient preparation, protected rules, durable pre-effect journaling and
// reconciliation, fresh local and authenticated remote approvals, and a
// headless start that refuses without custody (docs/secrets.md). Invented
// credentials only; the disposable custody stands in for the platform store.
const TOKEN = "ghp_invented0StagingDeploy7Q2xV9mK4tR8wL1nB6cZ3";

/** A deploy script as a crewmate might write one: it prints what it got, carelessly. */
const DEPLOY = `#!/bin/sh
echo "deploying with $STAGING_DEPLOY_TOKEN"
printf '%s' "$STAGING_DEPLOY_TOKEN" | base64
env | sed 's/=.*//' | sort > "$PWD/received-names"
echo run >> "$PWD/runs.log"
case "$STAGING_DEPLOY_TOKEN" in ghp_invented*) exit 7 ;; *) exit 9 ;; esac
`;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function project() {
  const dir = realpathSync(scratchDir("secrets-project-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "deploy-staging.sh"), DEPLOY);
  return dir;
}

function deploy(cwd: string, id = "deploy-staging"): Injection {
  return {
    id,
    reason: "Deploy the reviewed staging build",
    env: { STAGING_DEPLOY_TOKEN: "staging-deploy" },
    argv: ["/bin/sh", "scripts/deploy-staging.sh"],
    cwd,
  };
}

const presentPerson: FreshAuthentication = {
  available: async () => true,
  confirm: async () => true,
};

/** The app's own environment, carrying what a recipient must never inherit. */
const environment = () =>
  hostEnv({
    INFINITARY_AXI_CHANNEL: "/Users/captain/Library/Application Support/infinitary/axi/task.key",
    AWS_SECRET_ACCESS_KEY: "inherited-invented-aws-key",
  });

async function open(options: Partial<ProtectedSecretsOptions> & { dir: string }) {
  return ProtectedSecrets.open({
    custody: disposableCustody(),
    authentication: presentPerson,
    environment,
    initialize: true,
    ...options,
  });
}

async function owner(options: Omit<Partial<ProtectedSecretsOptions>, "custody"> = {}) {
  const dir = scratchDir("secrets-owner-");
  const custody = disposableCustody();
  const backend = await open({ dir, custody, ...options });
  expect(backend.availability).toBe("available");
  await backend.putSecret("staging-deploy", "Staging deploy token", Buffer.from(TOKEN), {
    discoverable: true,
  });
  return { dir, custody, backend, requests: new SecretRequests(backend) };
}

async function approveLocally(
  backend: ProtectedSecrets,
  requests: SecretRequests,
  request: string,
) {
  const pending = requests.pending(request);
  if (!pending) throw new Error("not waiting");
  return backend.confirmUse(request, pending.digest, pending.expires, "Run deploy-staging.sh");
}

async function allow(backend: ProtectedSecrets, input: Injection) {
  const rehearsal = await backend.rehearse(input);
  if (!rehearsal) throw new Error("rehearsal refused");
  const proposal = backend.proposeAuthority({
    rules: [
      {
        id: "allow-deploy",
        effect: "allow",
        secret: "staging-deploy",
        operation: rehearsal.operation,
      },
    ],
    devices: backend.authority()?.devices ?? [],
  });
  if (!proposal) throw new Error("no authority");
  const proof = await backend.confirmAuthority(proposal.digest, Date.now() + 300_000, "Save rule");
  expect(await backend.saveAuthority(proposal.authority, proof)).toBe("stored");
}

function leaks(text: string) {
  return text.includes(TOKEN) || text.includes(Buffer.from(TOKEN).toString("base64"));
}

describe("protected Secrets owner", () => {
  // Regression: an unlanded authority save must not permanently
  // disable first setup or a legacy/recovered home. Both writer and reader
  // are real, separate processes; custody alone is a persisted disposable fixture.
  it.for(
    ["first", "legacy", "recovered"].flatMap((layout) =>
      (["lost-reply", "before-native"] as const).map((interruption) => ({ layout, interruption })),
    ),
  )(
    "restarts $layout authority after $interruption without replay",
    async ({ layout, interruption }, { signal }) => {
      const dir = scratchDir("secrets-authority-restart-");
      const custody = disposableCustody();
      let committed: ReturnType<ProtectedSecrets["authority"]>;
      if (layout === "first") {
        const keys = await RootKeys.open(custody, { initialize: true, hasRecords: false });
        if (typeof keys === "string") throw new Error("No fixture root.");
        keys.destroy();
      } else {
        let backend = await open({ dir, custody });
        await backend.putSecret("staging-deploy", "Staging deploy token", Buffer.from(TOKEN));
        if (layout === "recovered") {
          let backup: RecoveryFiles | undefined;
          expect(
            await backend.backupRecovery(async (files) => {
              backup = { archive: Buffer.from(files.archive), key: Buffer.from(files.key) };
              return "saved";
            }),
          ).toBe("saved");
          if (!backup) throw new Error("No fixture recovery files.");
          try {
            const requests = new SecretRequests(backend);
            expect(await backend.restoreRecovery(backup, () => requests.pauseForRecovery())).toBe(
              "restored",
            );
          } finally {
            backup.archive.fill(0);
            backup.key.fill(0);
          }
          backend = await open({ dir, custody });
        }
        committed = backend.authority();
      }
      const home = await openSecretHome(dir, custody);
      if (typeof home === "string") throw new Error("No fixture home.");
      const file = join(dir, "disposable-custody.json");
      writeFileSync(
        file,
        JSON.stringify({
          dir,
          interruption,
          writes: [],
          slots: [...custody.slots].map(([slot, value]) => [slot, value.toString("base64")]),
        }),
        { mode: 0o600 },
      );
      const script = `
      import { openModuleRunner } from ${JSON.stringify(pathToFileURL(resolve("scripts/moduleRunner.ts")).href)};
      const runner = await openModuleRunner();
      try {
        const { authorityRestart } = await runner.import(${JSON.stringify(resolve("tests/helpers/authorityRestart.ts"))});
        console.log(JSON.stringify(await authorityRestart(process.argv[1], process.argv[2])));
      } finally { await runner.close(); }
    `;
      const inProcess = async (phase: string) =>
        (
          await promisify(execFile)(
            process.execPath,
            ["--input-type=module", "-e", script, file, phase],
            { env: hostEnv(), signal },
          )
        ).stdout.trim();
      const interrupted = await inProcess("interrupt");
      if (interruption === "lost-reply")
        expect(JSON.parse(interrupted)).toEqual({
          status: "unavailable",
          pending: true,
          writes: [],
        });
      expect(existsSync(join(home.dir, "authority.next.json"))).toBe(true);
      const candidate = JSON.parse(readFileSync(file, "utf8")).candidate;
      const reopened = JSON.parse(await inProcess("reopen"));
      expect(reopened).toMatchObject({
        status: "available",
        saved: "stored",
        confirmations: 1,
        pending: false,
        refusals: [
          { status: "locked", pending: true },
          { status: "unavailable", pending: true },
        ],
      });
      if (layout === "first") {
        expect(reopened.authority).toMatchObject({ revision: 0, rules: [], devices: [] });
        expect(reopened.authority.home).not.toBe(candidate.home);
        expect(reopened.metadata).toEqual([]);
      } else {
        expect(reopened.authority).toEqual(committed);
        expect(reopened.valueDigest).toBe(sha256(TOKEN));
        expect(reopened.metadata).toHaveLength(1);
      }
      expect(reopened.writes).toEqual(
        layout === "first"
          ? ["authority-head", "authority-head"]
          : [layout === "recovered" ? "root" : "authority-head"],
      );
      expect(existsSync(join(home.dir, "authority.next.json"))).toBe(false);
    },
  );

  // INF-3042: a lost authority reply retires the live owner, including a use
  // prepared before the write. Native custody stands in; the recipient is real.
  it("retires prepared uses after an uncertain authority save", async () => {
    const cwd = project();
    const { dir, custody, backend, requests } = await owner();
    const receipt = await requests.inject(deploy(cwd));
    const useProof = await approveLocally(backend, requests, receipt.request);
    const proposal = backend.proposeAuthority({ rules: [], devices: [] });
    if (!proposal) throw new Error("No fixture authority.");
    const proof = await backend.confirmAuthority(
      proposal.digest,
      Date.now() + 300_000,
      "Save rules",
    );
    const write = custody.write;
    const attempted = vi.spyOn(custody, "write").mockImplementation(async (slot, bytes) => {
      await write(slot, bytes);
      throw new Error("Fixture lost the native write response.");
    });
    await expect(backend.saveAuthority(proposal.authority, proof)).rejects.toThrow(
      "lost the native",
    );
    expect(await backend.status()).toBe("unavailable");
    expect(await backend.list()).toEqual([]);
    expect((await requests.approve(receipt.request, useProof))?.state).toBe("invalidated");
    expect(existsSync(join(cwd, "runs.log"))).toBe(false);
    expect((await requests.inject(deploy(cwd, "after-uncertainty"))).state).toBe("unavailable");
    expect(existsSync(join(dir, "authority.next.json"))).toBe(true);
    expect(attempted).toHaveBeenCalledTimes(1);
  });

  it("runs one approved exact use with only its mapped value, from a private copy of the script, and keeps output private", async () => {
    const cwd = project();
    const { dir, backend, requests } = await owner();
    const receipt = await requests.inject(deploy(cwd));
    expect(receipt.state).toBe("waiting");
    const described = backend.describe(receipt.request);
    // A system program runs in place: nothing this user runs can replace it.
    expect(described?.facts.executable).toMatchObject({
      path: realpathSync("/bin/sh"),
      copied: false,
    });
    expect(described?.facts.inputs).toEqual([
      { index: 1, path: join(cwd, "scripts", "deploy-staging.sh"), sha256: expect.any(String) },
    ]);
    expect(described?.secrets).toEqual([
      { ref: "staging-deploy", label: "Staging deploy token", version: 1 },
    ]);

    // After the request, the crewmate's script changes; the approval covers the copy.
    writeFileSync(
      join(cwd, "scripts", "deploy-staging.sh"),
      "#!/bin/sh\necho changed >> runs.log\nexit 1\n",
    );
    expect((await requests.approve(receipt.request, { kind: "local" }))?.state).toBe("waiting");
    const proof = await approveLocally(backend, requests, receipt.request);
    await Promise.all([
      requests.approve(receipt.request, proof),
      requests.approve(receipt.request, proof),
    ]);
    expect(requests.status(receipt.request)).toEqual({
      request: receipt.request,
      state: "completed",
      exitCode: 7,
    });
    expect(readFileSync(join(cwd, "runs.log"), "utf8")).toBe("run\n");

    const names = readFileSync(join(cwd, "received-names"), "utf8").trim().split("\n");
    expect(names).toContain("STAGING_DEPLOY_TOKEN");
    expect(names).toContain("PATH");
    expect(
      names.filter((name) => name.startsWith("INFINITARY_") || name.startsWith("GIT_")),
    ).toEqual([]);
    expect(names).not.toContain("AWS_SECRET_ACCESS_KEY");

    expect(readdirSync(join(dir, "runs"))).toEqual([]);
    expect(backend.history()).toMatchObject([
      { request: receipt.request, state: "completed", exitCode: 7, approval: "local" },
    ]);
    const answers = JSON.stringify([
      requests.receipts(),
      backend.history(),
      backend.exportHistory(),
    ]);
    expect(leaks(answers)).toBe(false);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json") || file.endsWith(".jsonl"))
        expect(leaks(readFileSync(join(dir, file), "utf8"))).toBe(false);
    }
  });

  /** A tool the crewmate installed on the search path: a script this user can change. */
  async function toolOwner() {
    const tools = realpathSync(scratchDir("secrets-tools-"));
    const tool = join(tools, "deploy-tool");
    writeFileSync(tool, '#!/bin/sh\necho ran >> "$PWD/runs.log"\n');
    chmodSync(tool, 0o755);
    const cwd = project();
    const opened = await owner({
      environment: () => ({ ...environment(), PATH: `${tools}:${environment().PATH}` }),
    });
    const receipt = await opened.requests.inject({ ...deploy(cwd), argv: ["deploy-tool"] });
    const proof = await approveLocally(opened.backend, opened.requests, receipt.request);
    return { ...opened, tool, cwd, receipt, proof };
  }

  it("runs the approved copy of a program found on the search path, even after the program changes", async () => {
    const { backend, requests, tool, cwd, receipt, proof } = await toolOwner();
    expect(backend.describe(receipt.request)?.facts).toMatchObject({
      executable: { path: tool, copied: true },
      interpreter: { path: realpathSync("/bin/sh"), copied: false },
    });
    writeFileSync(tool, '#!/bin/sh\necho replaced >> "$PWD/runs.log"\n');
    expect((await requests.approve(receipt.request, proof))?.state).toBe("completed");
    expect(readFileSync(join(cwd, "runs.log"), "utf8")).toBe("ran\n");
  });

  it.each([
    ["its private copy is changed", "copy"],
    ["the secret is replaced", "secret"],
    ["the rules are saved again", "rules"],
  ] as const)("does not run an approved use when %s after the request", async (_name, change) => {
    const { dir, backend, requests, cwd, receipt, proof } = await toolOwner();
    if (change === "copy") {
      // A same-user program reaching into the owner's private folder.
      const copy = join(dir, "runs", receipt.request, "inputs", "program", "deploy-tool");
      chmodSync(copy, 0o700);
      writeFileSync(copy, '#!/bin/sh\necho replaced >> "$PWD/runs.log"\n');
    }
    if (change === "secret")
      await backend.putSecret(
        "staging-deploy",
        "Staging deploy token",
        Buffer.from(`${TOKEN}-rotated`),
      );
    if (change === "rules") {
      const proposal = backend.proposeAuthority({ rules: [], devices: [] });
      if (!proposal) throw new Error("no authority");
      const save = await backend.confirmAuthority(
        proposal.digest,
        Date.now() + 300_000,
        "Save rules",
      );
      await backend.saveAuthority(proposal.authority, save);
    }
    expect((await requests.approve(receipt.request, proof))?.state).toBe("invalidated");
    expect(existsSync(join(cwd, "runs.log"))).toBe(false);
    expect(backend.history()).toMatchObject([{ state: "invalidated" }]);
  });

  // INF-1254's review of INF-1109: a policy or credential change during the
  // final metadata read or launch I/O must still stop the real process.
  it.each([
    ["replace", "metadata"],
    ["never", "metadata"],
    ["replace", "launch-output"],
    ["never", "launch-output"],
    ["copy", "launch-output"],
  ] as const)("does not launch after %s during the last %s await", async (change, boundary) => {
    const { dir, backend, requests, cwd, receipt, proof } = await toolOwner();
    const entered = deferred();
    const resume = deferred();
    let valueOpened = false;
    let held = false;
    const hold = async () => {
      held = true;
      entered.resolve();
      await resume.promise;
    };
    const originalOpen = SecretVault.prototype.open;
    const opened = vi.spyOn(SecretVault.prototype, "open").mockImplementation(async function (
      this: SecretVault,
      ref: string,
    ) {
      const result = await originalOpen.call(this, ref);
      valueOpened = true;
      return result;
    });
    const originalEntry = SecretVault.prototype.entry;
    const entry = vi.spyOn(SecretVault.prototype, "entry").mockImplementation(async function (
      this: SecretVault,
      ref: string,
    ) {
      const result = await originalEntry.call(this, ref);
      if (boundary === "metadata" && valueOpened && !held) await hold();
      return result;
    });
    const originalFileOpen = files.open;
    const output = vi.spyOn(files, "open").mockImplementation(async (...args) => {
      const result = await originalFileOpen(...args);
      if (
        boundary === "launch-output" &&
        String(args[0]) === join(dir, "runs", receipt.request, "out", "stderr") &&
        !held
      )
        await hold();
      return result;
    });
    const approval = requests.approve(receipt.request, proof);
    try {
      await entered.promise;
      if (change === "replace")
        await backend.putSecret(
          "staging-deploy",
          "Staging deploy token",
          Buffer.from(`${TOKEN}-new`),
        );
      else if (change === "copy") {
        const copy = join(dir, "runs", receipt.request, "inputs", "program", "deploy-tool");
        chmodSync(copy, 0o700);
        writeFileSync(copy, '#!/bin/sh\necho changed >> "$PWD/runs.log"\n');
      } else {
        const proposal = backend.proposeAuthority({
          rules: [{ id: "stop", secret: "staging-deploy", effect: "never" }],
          devices: [],
        });
        if (!proposal) throw new Error("No policy proposal.");
        const confirmation = await backend.confirmAuthority(
          proposal.digest,
          Date.now() + SECRET_REQUEST_LIFETIME_MS,
          "Stop deployment access",
        );
        expect(await backend.saveAuthority(proposal.authority, confirmation)).toBe("stored");
      }
    } finally {
      resume.resolve();
      await approval;
      opened.mockRestore();
      entry.mockRestore();
      output.mockRestore();
    }
    expect(requests.status(receipt.request)?.state).toBe("invalidated");
    expect(existsSync(join(cwd, "runs.log"))).toBe(false);
    expect(readdirSync(join(dir, "runs"))).toEqual([]);
  });

  it("runs a saved reviewed script without asking, asks again once it changes, and saves rules only with fresh authentication", async () => {
    const cwd = project();
    const { backend, requests } = await owner();
    const unconfirmed = backend.proposeAuthority({ rules: [], devices: [] });
    if (!unconfirmed) throw new Error("no authority");
    expect(await backend.saveAuthority(unconfirmed.authority, { kind: "local" })).toBe("refused");

    await allow(backend, deploy(cwd));
    const first = await requests.inject(deploy(cwd, "deploy-1"));
    await expect.poll(() => requests.status(first.request)?.state).toBe("completed");
    expect(requests.status(first.request)?.exitCode).toBe(7);
    expect(backend.history()).toMatchObject([{ approval: "rule", state: "completed" }]);

    writeFileSync(join(cwd, "scripts", "deploy-staging.sh"), `${DEPLOY}# one more line\n`);
    expect((await requests.inject(deploy(cwd, "deploy-2"))).state).toBe("waiting");
  });

  it("after a launch interrupted by a crash, reports unknown, removes private files, and never runs that intent again", async () => {
    const cwd = project();
    const release = join(cwd, "release");
    execFileSync("mkfifo", [release]);
    writeFileSync(
      join(cwd, "scripts", "deploy-staging.sh"),
      `#!/bin/sh\necho run >> "$PWD/runs.log"\n: > "$PWD/started"\nread _ < "$PWD/release"\nexit 0\n`,
    );
    const { dir, custody, backend, requests } = await owner();
    const receipt = await requests.inject(deploy(cwd));
    const approving = requests.approve(
      receipt.request,
      await approveLocally(backend, requests, receipt.request),
    );
    await expect.poll(() => existsSync(join(cwd, "started"))).toBe(true);
    // The computer stops here: what is on disk is what the next start finds.
    const crashed = scratchDir("secrets-crashed-");
    cpSync(dir, crashed, { recursive: true });
    expect(readdirSync(join(crashed, "runs"))).toEqual([receipt.request]);
    writeFileSync(release, "go\n");
    await approving;

    const restarted = await open({ dir: crashed, custody, initialize: false });
    expect(existsSync(join(crashed, "runs"))).toBe(false);
    const again = new SecretRequests(restarted);
    expect(again.status(receipt.request)).toEqual({ request: receipt.request, state: "unknown" });
    expect(await again.inject(deploy(cwd))).toEqual({ request: receipt.request, state: "unknown" });
    expect(restarted.history()).toMatchObject([{ state: "unknown", reconciled: true }]);
    expect(readFileSync(join(cwd, "runs.log"), "utf8")).toBe("run\n");
  });

  it("starts headless: refuses without custody, waits for a person, and accepts one signed remote decision", async () => {
    const cwd = project();
    const { dir, custody, backend } = await owner();
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const proposal = backend.proposeAuthority({
      rules: [],
      devices: [
        {
          device: "phone-1",
          label: "Kun's iPhone",
          generation: 1,
          publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        },
      ],
    });
    if (!proposal) throw new Error("no authority");
    const proof = await backend.confirmAuthority(
      proposal.digest,
      Date.now() + 300_000,
      "Enroll phone",
    );
    expect(await backend.saveAuthority(proposal.authority, proof)).toBe("stored");

    custody.state = "unavailable";
    const refusing = await open({ dir, custody, authentication: undefined, initialize: false });
    expect(refusing.availability).toBe("unavailable");
    expect(await refusing.list()).toEqual([]);
    expect((await new SecretRequests(refusing).inject(deploy(cwd))).state).toBe("unavailable");

    custody.state = "open";
    const headless = await open({ dir, custody, authentication: undefined, initialize: false });
    const requests = new SecretRequests(headless);
    const receipt = await requests.inject(deploy(cwd));
    const pending = requests.pending(receipt.request);
    if (!pending) throw new Error("not waiting");
    expect(
      await headless.confirmUse(receipt.request, pending.digest, pending.expires, "Run"),
    ).toBeUndefined();
    const challenge = headless.challenge(receipt.request, pending.digest, pending.expires);
    if (!challenge) throw new Error("no challenge");
    const message = decisionMessage({
      home: challenge.home,
      device: "phone-1",
      generation: 1,
      request: receipt.request,
      digest: pending.digest,
      nonce: challenge.nonce,
      expires: pending.expires,
    });
    const decision = {
      kind: "remote",
      device: "phone-1",
      generation: 1,
      nonce: challenge.nonce,
      signature: sign("sha256", Buffer.from(message), {
        key: privateKey,
        dsaEncoding: "der",
      }).toString("base64"),
    };
    await Promise.all([
      requests.approve(receipt.request, decision),
      requests.approve(receipt.request, decision),
    ]);
    expect(requests.status(receipt.request)).toEqual({
      request: receipt.request,
      state: "completed",
      exitCode: 7,
    });
    expect(readFileSync(join(cwd, "runs.log"), "utf8")).toBe("run\n");
    expect(headless.history()).toMatchObject([
      { approval: "remote", device: "phone-1", state: "completed" },
    ]);
  });

  it("answers an unknown reference, a hidden one and a mapping onto a base variable alike", async () => {
    const cwd = project();
    const { backend, requests } = await owner();
    await backend.putSecret("prod-deploy", "Production deploy token", Buffer.from("prod-invented"));
    expect((await backend.list()).map((secret) => secret.ref)).toEqual(["staging-deploy"]);
    const unknown = await requests.inject({
      ...deploy(cwd, "a"),
      env: { TOKEN: "no-such-secret" },
    });
    const hidden = await requests.inject({ ...deploy(cwd, "b"), env: { TOKEN: "prod-deploy" } });
    const base = await requests.inject({ ...deploy(cwd, "c"), env: { LANG: "staging-deploy" } });
    expect([unknown.state, hidden.state, base.state]).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(existsSync(join(cwd, "runs.log"))).toBe(false);
  });
});
