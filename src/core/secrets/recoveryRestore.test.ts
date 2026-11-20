import { generateKeyPairSync } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { SecretBroker } from "./brokers";
import { type CustodyWrite, canonical, sha256 } from "./custody";
import { ProtectedSecrets } from "./protected";
import type { RecoveryFiles } from "./recoveryArchive";
import { secretHistoryFiles } from "./recoveryHome";
import { SECRET_REQUEST_LIFETIME_MS, SecretRequests } from "./requests";

// Intent: INF-1109 restores values without restoring authority, losing history,
// replacing an in-flight use, or replaying an unknown native write. Native custody
// and human authentication stand in; the actual owner, journal, archive and files run.
const TOKEN = "ya29.invented-restore-token";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const dir = scratchDir("secrets-restore-");
  const custody = disposableCustody();
  let confirmed = true;
  let confirmations = 0;
  let wait: (() => Promise<void>) | undefined;
  const received: string[] = [];
  const broker: SecretBroker = {
    id: "calendar",
    prepare: async (input) => ({
      facts: {
        broker: "calendar",
        label: "Calendar",
        destination: "https://calendar.example.test/events",
        operation: "Read calendar events",
        inputDigest: sha256(canonical(input)),
        read: true,
        result: "Trusted consumer",
        secrets: { bearer: "calendar" },
      },
      run: async (values) => {
        received.push(values.bearer?.toString() ?? "");
        await wait?.();
        return { completed: true };
      },
    }),
  };
  const options = {
    dir,
    custody,
    initialize: true,
    environment: () => ({}),
    brokers: [broker],
    authentication: {
      available: async () => true,
      confirm: async () => {
        confirmations++;
        return confirmed;
      },
    },
  };
  const owner = await ProtectedSecrets.open(options);
  await owner.putSecret("calendar", "Calendar", Buffer.from(TOKEN));
  const requests = new SecretRequests(owner);
  const input = (id: string) => ({
    id,
    broker: "calendar",
    reason: "Read my planning events",
    input: { calendar: "planning" },
  });
  const approve = async (
    backend: ProtectedSecrets,
    coordinator: SecretRequests,
    request: string,
  ) => {
    const pending = coordinator.pending(request);
    if (!pending) throw new Error("No pending fixture request.");
    const proof = await backend.confirmUse(
      request,
      pending.digest,
      pending.expires,
      "Allow the fixture read",
    );
    return coordinator.approve(request, proof);
  };
  const read = async (id: string) => {
    const receipt = await requests.broker(input(id));
    expect((await approve(owner, requests, receipt.request))?.state).toBe("completed");
    owner.takeBrokerResult(receipt.request);
    return receipt;
  };
  await read("before-backup");
  let files: RecoveryFiles | undefined;
  expect(
    await owner.backupRecovery(async (output) => {
      files = { archive: Buffer.from(output.archive), key: Buffer.from(output.key) };
      return "saved";
    }),
  ).toBe("saved");
  if (!files) throw new Error("No fixture backup.");
  return {
    dir,
    custody,
    owner,
    requests,
    options,
    files,
    input,
    approve,
    read,
    received,
    confirmations: () => confirmations,
    confirm: (value: boolean) => {
      confirmed = value;
    },
    wait: (value: (() => Promise<void>) | undefined) => {
      wait = value;
    },
  };
}

describe("protected recovery restore", () => {
  it("a retired coordinator's discovery returns no entries instead of using destroyed keys", async () => {
    const f = await fixture();
    await f.owner.putSecret("calendar", "Calendar", Buffer.from(TOKEN), { discoverable: true });
    expect(await f.requests.list()).toHaveLength(1);
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "restored",
    );
    expect(await f.requests.list()).toEqual([]);
  });

  it("history deletion preserves a waiting request so its later outcome survives reopening", async () => {
    const f = await fixture();
    const input = f.input("waiting-at-history-delete");
    const waiting = await f.requests.broker(input);
    const before = await readFile(join(f.dir, "history.jsonl"));
    expect(await f.owner.clearHistory()).toBe("busy");
    expect(await readFile(join(f.dir, "history.jsonl"))).toEqual(before);
    expect((await f.approve(f.owner, f.requests, waiting.request))?.state).toBe("completed");
    f.owner.takeBrokerResult(waiting.request);
    const reopened = await ProtectedSecrets.open(f.options);
    const requests = new SecretRequests(reopened);
    expect(await requests.broker(input)).toMatchObject({
      request: waiting.request,
      state: "completed",
    });
    expect(f.received).toEqual([TOKEN, TOKEN]);
    expect(await f.owner.clearHistory()).toBe("cleared");
    expect(await secretHistoryFiles(f.dir)).toEqual([]);
  });

  it("a real staging filesystem failure leaves the selected home and history usable", async () => {
    const f = await fixture();
    const root = Buffer.from(f.custody.slots.get("root") ?? []);
    const home = f.owner.authority()?.home;
    const history = f.owner.history();
    const writes = f.custody.writes.length;
    const obstruction = join(f.dir, "recovered");
    await writeFile(obstruction, "fixture obstruction, not a directory");
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "unavailable",
    );
    expect(f.custody.writes).toHaveLength(writes);
    expect(f.custody.slots.get("root")).toEqual(root);
    expect(f.owner.authority()?.home).toBe(home);
    expect(f.owner.history()).toEqual(history);
    expect(await f.owner.status()).toBe("available");
    await rm(obstruction);
    await f.read("after-failed-staging");
    expect(f.received).toEqual([TOKEN, TOKEN]);
  });

  it("restores the credential with fresh authority, keeps local history and labels archive history without replay", async () => {
    const f = await fixture();
    const original = (await f.owner.metadata())[0];
    if (!original) throw new Error("No original entry.");
    const home = f.owner.authority()?.home;
    await f.owner.putSecret("calendar", "Later calendar", Buffer.from(`${TOKEN}-later`));
    const later = await f.read("after-backup");
    const waiting = await f.requests.broker(f.input("waiting-at-restore"));
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const proposal = f.owner.proposeAuthority({
      rules: [{ id: "old-rule", secret: "calendar", effect: "ask" }],
      devices: [
        {
          device: "fixture-device",
          label: "Fixture device",
          generation: 1,
          publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        },
      ],
    });
    if (!proposal) throw new Error("No authority proposal.");
    const proof = await f.owner.confirmAuthority(
      proposal.digest,
      Date.now() + SECRET_REQUEST_LIFETIME_MS,
      "Save fixture authority",
    );
    expect(await f.owner.saveAuthority(proposal.authority, proof)).toBe("stored");
    const beforeHistory = await readFile(join(f.dir, "history.jsonl"));
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "restored",
    );
    expect(f.requests.status(waiting.request)?.state).toBe("invalidated");
    expect(await f.owner.status()).toBe("unavailable");
    const restored = await ProtectedSecrets.open(f.options);
    expect(await restored.status()).toBe("available");
    expect(restored.authority()?.home).not.toBe(home);
    expect(restored.authority()?.rules).toEqual([]);
    expect(restored.authority()?.devices).toEqual([]);
    expect((await restored.metadata())[0]?.revision).not.toBe(original.revision);
    expect(
      await restored.putSecret(original.ref, "Stale form", Buffer.from("must-not-save"), {
        expectedVersion: original.version,
        expectedRevision: original.revision,
      }),
    ).toBeUndefined();
    expect(restored.history().find((row) => row.request === later.request)?.state).toBe(
      "completed",
    );
    expect(restored.history().some((row) => row.recoveredFrom === home)).toBe(true);
    expect(
      (await readFile(join(f.dir, "history.jsonl"))).subarray(0, beforeHistory.length),
    ).toEqual(beforeHistory);
    const requests = new SecretRequests(restored);
    expect(requests.receipts().every((receipt) => !receipt.request.startsWith("recovered:"))).toBe(
      true,
    );
    const receipt = await requests.broker(f.input("read-restored"));
    expect(receipt.state).toBe("waiting");
    expect((await f.approve(restored, requests, receipt.request))?.state).toBe("completed");
    restored.takeBrokerResult(receipt.request);
    expect(f.received.at(-1)).toBe(TOKEN);
    const bytes = await Promise.all(
      (await secretHistoryFiles(f.dir)).map(async (path) => (await stat(path)).size),
    );
    expect(await restored.storageUse()).toBe(bytes.reduce((sum, one) => sum + one, 0));
    expect(await restored.clearHistory()).toBe("cleared");
    expect(restored.history()).toEqual([]);
    expect(await secretHistoryFiles(f.dir)).toEqual([]);
    expect((await restored.metadata())[0]?.label).toBe("Calendar");
  });

  it("refuses bad authentication tags before native confirmation or any store change", async () => {
    const f = await fixture();
    const bad = Buffer.from(f.files.archive);
    bad[bad.length - 1] = (bad.at(-1) ?? 0) ^ 1;
    const writes = f.custody.writes.length;
    const confirmations = f.confirmations();
    expect(
      await f.owner.restoreRecovery({ ...f.files, archive: bad }, () =>
        f.requests.pauseForRecovery(),
      ),
    ).toBe("invalid");
    expect(f.confirmations()).toBe(confirmations);
    expect(f.custody.writes.length).toBe(writes);
  });

  it("leaves waiting uses and custody intact when the person cancels confirmation", async () => {
    const f = await fixture();
    const waiting = await f.requests.broker(f.input("still-waiting"));
    const root = Buffer.from(f.custody.slots.get("root") ?? []);
    f.confirm(false);
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "refused",
    );
    expect(f.requests.status(waiting.request)?.state).toBe("waiting");
    expect(f.custody.slots.get("root")).toEqual(root);
  });

  it("refuses while an effect is running or its result is uncollected, then restores after delivery", async () => {
    const f = await fixture();
    const started = deferred<void>();
    const finish = deferred<void>();
    f.wait(async () => {
      started.resolve();
      await finish.promise;
    });
    const receipt = await f.requests.broker(f.input("in-flight"));
    const approval = f.approve(f.owner, f.requests, receipt.request);
    await started.promise;
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "busy",
    );
    finish.resolve();
    expect((await approval)?.state).toBe("completed");
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "busy",
    );
    f.owner.takeBrokerResult(receipt.request);
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "restored",
    );
  });

  it("keeps an unknown native commit for reconciliation without writing it again", async () => {
    const f = await fixture();
    const write = f.custody.write;
    const writes = f.custody.writes.length;
    f.custody.write = async (slot, bytes) => {
      const result = await write(slot, bytes);
      if (slot === "root") {
        f.custody.state = "unavailable";
        throw new Error("Fixture lost the response.");
      }
      return result;
    };
    expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
      "unknown",
    );
    expect(f.custody.writes.slice(writes)).toEqual(["root"]);
    expect(await f.owner.status()).toBe("unavailable");
    f.custody.state = "open";
    const reopened = await ProtectedSecrets.open(f.options);
    expect(await reopened.status()).toBe("available");
    expect((await reopened.metadata())[0]?.label).toBe("Calendar");
    expect(f.custody.writes.slice(writes)).toEqual(["root"]);
  });

  it("retains staged files when a failed native reply precedes a later commit", async () => {
    const f = await fixture();
    const originalHome = f.owner.authority()?.home;
    const write = f.custody.write;
    let pending: Buffer | undefined;
    let finishNative: (() => Promise<CustodyWrite>) | undefined;
    let attempts = 0;
    f.custody.write = async (slot, bytes) => {
      if (slot !== "root") return write(slot, bytes);
      attempts += 1;
      const copied = Buffer.from(bytes);
      pending = copied;
      finishNative = () => write(slot, copied);
      // The response fails while readback still sees the old root. That is
      // not a refusal: the native service may finish the already-sent write.
      throw new Error("Fixture native write has no response yet.");
    };
    try {
      expect(await f.owner.restoreRecovery(f.files, () => f.requests.pauseForRecovery())).toBe(
        "unknown",
      );
      expect(await f.owner.status()).toBe("unavailable");
      if (!finishNative) throw new Error("No native write was submitted.");
      expect(await finishNative()).toBe("stored");
      const reopened = await ProtectedSecrets.open(f.options);
      expect(await reopened.status()).toBe("available");
      expect(reopened.authority()?.home).not.toBe(originalHome);
      expect((await reopened.metadata())[0]?.label).toBe("Calendar");
      expect(attempts).toBe(1);
    } finally {
      pending?.fill(0);
    }
  });

  // INF-3042: damaged permissions do not invalidate an independently authenticated journal.
  it("re-keys local history when authority is damaged but custody is readable", async () => {
    const f = await fixture();
    const later = await f.read("after-backup-before-damage");
    const sends = f.received.length;
    await writeFile(join(f.dir, "authority.json"), "edited authority");
    const damaged = await ProtectedSecrets.open(f.options);
    expect(damaged.availability).toBe("tampered");
    const requests = new SecretRequests(damaged);
    expect(await damaged.restoreRecovery(f.files, () => requests.pauseForRecovery())).toBe(
      "restored",
    );
    const restored = await ProtectedSecrets.open(f.options);
    expect(restored.history()).toContainEqual(
      expect.objectContaining({ request: later.request, state: "completed" }),
    );
    expect(restored.history().some((row) => row.recoveredFrom !== undefined)).toBe(true);
    expect(restored.authority()).toMatchObject({ rules: [], devices: [] });
    const reopenedRequests = new SecretRequests(restored);
    expect(await reopenedRequests.broker(f.input("after-backup-before-damage"))).toEqual(
      f.requests.status(later.request),
    );
    expect(f.received.length).toBe(sends);
  });

  it("restores after root loss without deleting history that can no longer be authenticated", async () => {
    const f = await fixture();
    await f.read("not-in-the-backup");
    const raw = await readFile(join(f.dir, "history.jsonl"));
    f.custody.slots.delete("root");
    const lost = await ProtectedSecrets.open(f.options);
    expect(lost.availability).toBe("lost");
    const requests = new SecretRequests(lost);
    expect(await lost.restoreRecovery(f.files, () => requests.pauseForRecovery())).toBe("restored");
    const restored = await ProtectedSecrets.open(f.options);
    expect(await readFile(join(f.dir, "history.jsonl"))).toEqual(raw);
    expect(restored.history().every((row) => row.recoveredFrom !== undefined)).toBe(true);
    expect(await restored.storageUse()).toBeGreaterThan(raw.length);
  });
});
