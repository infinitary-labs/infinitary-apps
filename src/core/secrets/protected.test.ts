import { execFileSync } from "node:child_process";
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
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import { decisionMessage, type FreshAuthentication } from "./approvals";
import { ProtectedSecrets, type ProtectedSecretsOptions } from "./protected";
import { type Injection, SecretRequests } from "./requests";

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
