import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { SecretBroker } from "./brokers";
import { canonical, sha256 } from "./custody";
import { ProtectedSecrets } from "./protected";
import { SecretRequests } from "./requests";

// Intent: INF-3865, filed from INF-1659's live Linux check. A data folder
// removed while the computer's Keychain or Secret Service still holds that
// flavor's root and rules head opened Secrets as tampered, with only a restore
// from recovery files. Starting over is the captain's way out: one fresh system
// confirmation, a fresh root and empty rules, history kept, and nothing for a
// store that can still be used. Native custody and human confirmation stand in;
// the actual owner, sealed files, rules record and journal run.
const TOKEN = "invented-staging-deploy-token";

async function firstLife() {
  const dir = join(scratchDir("secrets-start-over-"), "secrets");
  const custody = disposableCustody();
  let confirmed = true;
  const reasons: string[] = [];
  const broker: SecretBroker = {
    id: "deploy",
    prepare: async (input) => ({
      facts: {
        broker: "deploy",
        label: "Deploy",
        destination: "https://deploy.example.test/status",
        operation: "Read deployment status",
        inputDigest: sha256(canonical(input)),
        read: true,
        result: "Trusted consumer",
        secrets: { bearer: "staging-deploy" },
      },
      run: async () => ({ completed: true }),
    }),
  };
  const options = {
    dir,
    custody,
    environment: () => ({}),
    brokers: [broker],
    authentication: {
      available: async () => true,
      confirm: async (reason: string) => {
        reasons.push(reason);
        return confirmed;
      },
    },
  };
  const owner = await ProtectedSecrets.open({ ...options, initialize: true });
  expect(
    await owner.putSecret("staging-deploy", "Staging deployment", Buffer.from(TOKEN)),
  ).toBeDefined();
  expect([...custody.slots.keys()].sort()).toEqual(["authority-head", "root"]);
  return {
    dir,
    custody,
    owner,
    options,
    reasons,
    confirm: (value: boolean) => {
      confirmed = value;
    },
    slots: () => new Map([...custody.slots].map(([slot, bytes]) => [slot, Buffer.from(bytes)])),
  };
}

async function startOver(owner: ProtectedSecrets) {
  const requests = new SecretRequests(owner);
  return owner.startOver(() => requests.pauseForRecovery());
}

describe("starting Secrets over", () => {
  it("a data folder removed beside its custody starts over with an empty store after one confirmation", async () => {
    const f = await firstLife();
    const before = f.slots();
    await rm(f.dir, { recursive: true });
    const leftover = await ProtectedSecrets.open(f.options);
    expect(leftover.availability).toBe("tampered");

    expect(await startOver(leftover)).toBe("started");
    expect(f.reasons).toHaveLength(1);
    const fresh = await ProtectedSecrets.open(f.options);
    expect(await fresh.status()).toBe("available");
    expect(await fresh.metadata()).toEqual([]);
    expect(fresh.authority()).toMatchObject({ revision: 0, rules: [], devices: [] });
    expect(f.custody.slots.get("root")).not.toEqual(before.get("root"));

    expect(
      await fresh.putSecret("staging-deploy", "Staging deployment", Buffer.from(TOKEN)),
    ).toMatchObject({ ref: "staging-deploy", version: 1 });
    const reopened = await ProtectedSecrets.open(f.options);
    expect((await reopened.metadata()).map((entry) => entry.label)).toEqual(["Staging deployment"]);
  });

  it("a refused confirmation leaves the leftover custody and its reading as they were", async () => {
    const f = await firstLife();
    await rm(f.dir, { recursive: true });
    const leftover = await ProtectedSecrets.open(f.options);
    const before = f.slots();
    const writes = f.custody.writes.length;
    f.confirm(false);

    expect(await startOver(leftover)).toBe("refused");
    expect(f.reasons).toHaveLength(1);
    expect(f.custody.slots).toEqual(before);
    expect(f.custody.writes).toHaveLength(writes);
    expect((await ProtectedSecrets.open(f.options)).availability).toBe("tampered");
  });

  it("a store that can be used, or is locked, is never started over and asks for nothing", async () => {
    const f = await firstLife();
    const before = f.slots();

    expect(await startOver(f.owner)).toBe("unneeded");
    f.custody.state = "locked";
    const locked = await ProtectedSecrets.open(f.options);
    expect(await startOver(locked)).toBe("locked");
    f.custody.state = "open";

    expect(f.reasons).toEqual([]);
    expect(f.custody.slots).toEqual(before);
    expect((await (await ProtectedSecrets.open(f.options)).metadata())[0]?.label).toBe(
      "Staging deployment",
    );
  });

  it("leaves the values it can no longer use behind and keeps the history its root still reads", async () => {
    const f = await firstLife();
    const requests = new SecretRequests(f.owner);
    const read = await requests.broker({
      id: "status-before-damage",
      broker: "deploy",
      reason: "Check the staging deployment",
      input: { environment: "staging" },
    });
    const pending = requests.pending(read.request);
    if (!pending) throw new Error("No pending fixture read.");
    const proof = await f.owner.confirmUse(
      read.request,
      pending.digest,
      pending.expires,
      "Allow the fixture read",
    );
    expect((await requests.approve(read.request, proof))?.state).toBe("completed");
    f.owner.takeBrokerResult(read.request);
    await writeFile(join(f.dir, "authority.json"), "edited authority");
    const damaged = await ProtectedSecrets.open(f.options);
    expect(damaged.availability).toBe("tampered");

    expect(await startOver(damaged)).toBe("started");
    const fresh = await ProtectedSecrets.open(f.options);
    expect(await fresh.metadata()).toEqual([]);
    expect(fresh.history()).toContainEqual(
      expect.objectContaining({ request: read.request, state: "completed" }),
    );
    expect(fresh.history().some((row) => row.recoveredFrom !== undefined)).toBe(false);
  });

  it("a root lost beside its sealed files starts over too", async () => {
    const f = await firstLife();
    f.custody.slots.delete("root");
    const lost = await ProtectedSecrets.open(f.options);
    expect(lost.availability).toBe("lost");

    expect(await startOver(lost)).toBe("started");
    const fresh = await ProtectedSecrets.open(f.options);
    expect(await fresh.status()).toBe("available");
    expect(await fresh.metadata()).toEqual([]);
  });
});
