import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../../core/hostEnv";
import { ProtectedSecrets } from "../../core/secrets/protected";
import { SecretRequests } from "../../core/secrets/requests";
import { createDarwinSecretCustody, loadDarwinCustodyApi } from "./darwinSecretCustody";

/**
 * Secrets custody on the REAL Security.framework path, opt-in:
 *
 *   INFINITARY_SCRATCH_KEYCHAIN_PROBE=1 pnpm vitest run src/main/host/darwinSecretCustody.scratch.test.ts
 *
 * Intent: INF-1105 - prove native custody on macOS before production Secrets
 * access (docs/secrets.md, "Native custody"). It creates a throwaway keychain
 * file in a scratch folder, aims every custody call at that one file, locks
 * it, and deletes it. Every `security` call runs with HOME at a scratch
 * folder, and the person's search list is read before and after to show it
 * unchanged. It never reads or writes an item of the person's own keychains.
 */
const enabled =
  process.platform === "darwin" && process.env.INFINITARY_SCRATCH_KEYCHAIN_PROBE === "1";

/** The throwaway keychain's password: invented, and gone with the file. */
const SCRATCH_PASSWORD = "infinitary-secrets-scratch";
const SERVICE = "Infinitary Secrets (scratch probe)";

let home = "";
let keychainPath = "";
let searchListBefore = "";

function security(...args: string[]): string {
  return execFileSync("/usr/bin/security", args, {
    env: { ...hostEnv(), HOME: home },
    encoding: "utf8",
    stdio: "pipe",
  });
}

/** The person's search list, read without the scratch HOME. Read only. */
function realSearchList(): string {
  return execFileSync("/usr/bin/security", ["list-keychains", "-d", "user"], {
    env: hostEnv(),
    encoding: "utf8",
  });
}

beforeAll(() => {
  if (!enabled) return;
  searchListBefore = realSearchList();
  home = realpathSync(scratchDir("secrets-keychain-home-"));
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  keychainPath = join(home, "secrets-scratch.keychain-db");
  security("create-keychain", "-p", SCRATCH_PASSWORD, keychainPath);
  security("set-keychain-settings", keychainPath);
  security("unlock-keychain", "-p", SCRATCH_PASSWORD, keychainPath);
});

afterAll(() => {
  if (!enabled) return;
  if (existsSync(keychainPath)) security("delete-keychain", keychainPath);
  expect(realSearchList()).toBe(searchListBefore);
});

it.skipIf(!enabled)(
  "holds the root and the authority head in a scratch keychain, refuses while it is locked, reads them for Unlock off the main thread, and serves a protected owner",
  async () => {
    const api = loadDarwinCustodyApi(keychainPath);
    expect(api).toBeDefined();
    const custody = createDarwinSecretCustody(api, { service: SERVICE });
    const root = Buffer.alloc(32, 9);
    expect(await custody.read("root")).toEqual({ kind: "absent" });
    expect(await custody.write("root", root)).toBe("stored");
    expect(await custody.read("root")).toEqual({ kind: "value", bytes: root });
    const head = Buffer.from(JSON.stringify({ revision: 1, digest: "0".repeat(64) }));
    expect(await custody.write("authority-head", head)).toBe("stored");
    const next = Buffer.from(JSON.stringify({ revision: 2, digest: "1".repeat(64) }));
    expect(await custody.write("authority-head", next)).toBe("stored");
    expect(await custody.read("authority-head")).toEqual({ kind: "value", bytes: next });
    // The item is in the scratch file alone (attributes only: no value is read).
    expect(security("find-generic-password", "-s", SERVICE, "-a", "root", keychainPath)).toContain(
      keychainPath,
    );

    security("lock-keychain", keychainPath);
    expect(await custody.read("root")).toEqual({ kind: "locked" });
    expect(await custody.write("root", Buffer.alloc(32))).toBe("locked");
    security("unlock-keychain", "-p", SCRATCH_PASSWORD, keychainPath);
    expect(await custody.read("root")).toEqual({ kind: "value", bytes: root });
    // Unlock's read, on the native worker thread: items this process made
    // trust it, so no dialog is shown.
    const asking = createDarwinSecretCustody(api, { service: SERVICE, interactive: true });
    expect(await asking.read("root")).toEqual({ kind: "value", bytes: root });
    expect(await asking.read("authority-head")).toEqual({ kind: "value", bytes: next });

    const owner = join(home, "owner");
    const fresh = createDarwinSecretCustody(api, { service: `${SERVICE} owner` });
    const opened = await ProtectedSecrets.open({
      dir: owner,
      custody: fresh,
      environment: () => hostEnv(),
      initialize: true,
    });
    expect(opened.availability).toBe("available");
    await opened.putSecret("staging-deploy", "Staging deploy token", Buffer.from("invented"), {
      discoverable: true,
    });
    const reopened = await ProtectedSecrets.open({
      dir: owner,
      custody: fresh,
      environment: () => hostEnv(),
    });
    expect(reopened.availability).toBe("available");
    expect((await reopened.list()).map((secret) => secret.ref)).toEqual(["staging-deploy"]);
    security("lock-keychain", keychainPath);
    const locked = await ProtectedSecrets.open({
      dir: owner,
      custody: fresh,
      environment: () => hostEnv(),
    });
    expect(locked.availability).toBe("locked");
    const project = scratchDir("secrets-keychain-project-");
    writeFileSync(join(project, "deploy.sh"), "#!/bin/sh\nexit 0\n");
    const receipt = await new SecretRequests(locked).inject({
      id: "deploy",
      reason: "Deploy staging",
      env: { TOKEN: "staging-deploy" },
      argv: ["/bin/sh", "deploy.sh"],
      cwd: project,
    });
    expect(receipt.state).toBe("unavailable");
  },
);
