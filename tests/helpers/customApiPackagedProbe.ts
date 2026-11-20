import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { app } from "electron";
import { appPathsFor } from "../../src/core/paths";
import { AccountVault } from "../../src/core/pi/accountVault";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import type { CustomApiInput } from "../../src/shared/customApi";

/** Built into a throwaway asar and run by its fuse-flipped Electron binary.
 * No window or real sign-in. Only the socket connector is a fixture seam;
 * the packaged Node runtime performs actual normal TLS verification. */
async function run() {
  assert.equal(app.isPackaged, true);
  const file = app.commandLine.getSwitchValue("fixture-config");
  const config = JSON.parse(readFileSync(file, "utf8")) as {
    stateRoot: string;
    baseUrl: string;
    expiredUrl: string;
    ca: string;
    otherCa: string;
    fingerprints: string[];
    otherFingerprints: string[];
  };
  const require = createRequire(join(app.getAppPath(), "package.json"));
  const dns = require("node:dns/promises") as typeof import("node:dns/promises");
  const https = require("node:https") as typeof import("node:https");
  const nativeRequest = https.request;
  const rootsBefore = [...rootCertificates];
  const pins: string[] = [];
  dns.lookup = (async () => [{ address: "10.23.4.5", family: 4 }]) as unknown as typeof dns.lookup;
  https.request = ((
    url: URL,
    options: import("node:https").RequestOptions,
    callback: (res: import("node:http").IncomingMessage) => void,
  ) => {
    assert(options.lookup);
    options.lookup(url.hostname, {}, (_error, address) => {
      assert.equal(address, "10.23.4.5");
      pins.push(String(address));
    });
    return nativeRequest(
      url,
      { ...options, lookup: (_host, _opts, done) => done(null, "127.0.0.1", 4) },
      callback,
    );
  }) as typeof https.request;
  syncBuiltinESMExports();
  const paths = appPathsFor(config.stateRoot);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: An executable-looking synthetic credential must remain literal.
  const key = "$(never-a-command) ${SYNTHETIC_NOT_AN_ENV_KEY}";
  const input: CustomApiInput = {
    label: "Packaged private connection",
    baseUrl: config.baseUrl,
    approvedDestination: config.baseUrl,
    mode: "private",
    protocol: "openai-responses",
    key,
    noKey: false,
    headers: [],
    unencryptedLocalApproved: false,
    allowStorageDefault: false,
    storageApproved: false,
    certificates: { pem: config.ca, fingerprints: config.fingerprints },
    models: [{ id: "packaged-model", context: 65536, output: 512 }],
  };
  const vault = AccountVault.create(paths);
  const prepared = vault.customPrepare(input);
  const draftId = prepared.draftId ?? "";
  assert.equal((await vault.customCheck(draftId, "packaged-model")).models[0]?.checked, true);
  const account = await vault.customSave(draftId, false);
  const authPath = join(paths.accountsDir, account.providerId, account.id, "custom-auth.json");
  const working = readFileSync(authPath, "utf8");
  assert.equal(statSync(authPath).mode & 0o777, 0o600);
  assert.equal(
    statSync(join(paths.accountsDir, account.providerId, account.id)).mode & 0o777,
    0o700,
  );
  assert(!JSON.stringify(await vault.views()).includes(key));
  const rt = await vault.runtimeFor(account.id);
  const model = rt.getModel(account.providerId, "packaged-model");
  assert(model);
  assert.equal(
    (
      await rt.completeSimple(model, {
        messages: [{ role: "user", content: "Synthetic packaged work", timestamp: Date.now() }],
      })
    ).stopReason,
    "stop",
  );
  const replace = vault.customPrepare({
    ...input,
    replaceAccountId: account.id,
    certificates: { pem: config.otherCa, fingerprints: config.otherFingerprints },
  });
  assert.equal(replace.models[0]?.checked, false);
  assert.equal(
    (await vault.customCheck(replace.draftId ?? "", "packaged-model")).models[0]?.state,
    "unreachable",
  );
  await assert.rejects(vault.customSave(replace.draftId ?? "", false));
  vault.customCancel(replace.draftId ?? "");
  assert.equal(readFileSync(authPath, "utf8"), working);
  const sibling = vault.customPrepare({
    ...input,
    label: "Untrusted sibling",
    certificates: undefined,
  });
  assert.equal(
    (await vault.customCheck(sibling.draftId ?? "", "packaged-model")).models[0]?.state,
    "unreachable",
  );
  const siblingAccount = await vault.customSave(sibling.draftId ?? "", true);
  for (const baseUrl of [
    config.expiredUrl,
    config.baseUrl.replace("gateway.example.test", "wrong.example.test"),
  ]) {
    const rejected = vault.customPrepare({ ...input, baseUrl, approvedDestination: baseUrl });
    assert.equal(
      (await vault.customCheck(rejected.draftId ?? "", "packaged-model")).models[0]?.state,
      "unreachable",
    );
    vault.customCancel(rejected.draftId ?? "");
  }
  // Normal/built-in Node TLS never gains this account's CA, even after use.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const request = nativeRequest(
        new URL(config.baseUrl),
        { lookup: (_host, _opts, done) => done(null, "127.0.0.1", 4) },
        resolve,
      );
      request.on("error", reject);
      request.end();
    }),
  );
  // A real restart kills the old owner; close its stand-in before reloading.
  vault.customClose(account.id);
  vault.customClose(siblingAccount.id);
  const restarted = AccountVault.create(paths);
  await restarted.warm();
  const view = restarted.customViews().find((entry) => entry.accountId === account.id);
  assert(view);
  assert.equal(view.models[0]?.checked, true);
  assert.deepEqual(
    view.certificates.map((cert) => cert.fingerprint),
    config.fingerprints,
  );
  const resumed = await restarted.runtimeFor(account.id);
  const resumedModel = resumed.getModel(account.providerId, "packaged-model");
  assert(resumedModel);
  assert.equal(
    (
      await resumed.completeSimple(resumedModel, {
        messages: [{ role: "user", content: "Synthetic restarted work", timestamp: Date.now() }],
      })
    ).stopReason,
    "stop",
  );
  await restarted.remove(account.id);
  assert.equal(
    (
      await resumed.completeSimple(resumedModel, {
        messages: [{ role: "user", content: "After removal", timestamp: Date.now() }],
      })
    ).stopReason,
    "error",
  );
  await catalogRefreshesSettled();
  assert.equal(existsSync(join(paths.accountsDir, account.providerId)), false);
  assert.equal(
    existsSync(join(paths.accountsDir, siblingAccount.providerId, siblingAccount.id)),
    true,
  );
  await restarted.remove(siblingAccount.id);
  assert.deepEqual([...rootCertificates], rootsBefore);
  assert(pins.length > 0);
  console.log(
    "CUSTOM_API_PACKAGED_TLS",
    JSON.stringify({
      packaged: app.isPackaged,
      electron: process.versions.electron,
      node: process.versions.node,
      approvedConnection: true,
      wrongNameRefused: true,
      expiredRefused: true,
      untrustedSiblingRefused: true,
      normalTrustUnchanged: true,
      replacementFailurePreservedWorkingRevision: true,
      certificateChangeInvalidatedProof: true,
      restartPreservedApprovalAndProof: true,
      removalDeletedOnlyMatchingStore: true,
      lateRuntimeDidNotRecreateFiles: true,
      literalKeyPrivate: true,
      validatedPins: [...new Set(pins)],
      socketConnectorOnly: "fixture loopback",
    }),
  );
}
app
  .whenReady()
  .then(run)
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(
        "PACKAGED_PROBE_FAILED",
        error instanceof Error ? error.message : "unknown failure",
      );
      app.exit(1);
    },
  );
