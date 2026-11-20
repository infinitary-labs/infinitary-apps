import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CustodySlot, RootKeys, sha256 } from "../../src/core/secrets/custody";
import { ProtectedSecrets } from "../../src/core/secrets/protected";
import { openSecretHome } from "../../src/core/secrets/recoveryHome";
import { SecretVault } from "../../src/core/secrets/vault";
import { disposableCustody } from "./disposableCustody";

/** Private fixture state only, discarded with protected.test.ts's scratch directory. */
type State = {
  dir: string;
  slots: [CustodySlot, string][];
  writes: CustodySlot[];
  interruption: "lost-reply" | "before-native";
  candidate?: unknown;
};

/**
 * Regression fixture for authority saves that never commit: each call runs
 * in a new Node process, with actual encrypted files and persisted disposable
 * custody. No native adapter, recipient, account or service is loaded.
 */
export async function authorityRestart(file: string, phase: "interrupt" | "reopen") {
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  const custody = disposableCustody();
  for (const [slot, value] of state.slots) custody.slots.set(slot, Buffer.from(value, "base64"));
  const persist = () => {
    state.slots = [...custody.slots].map(([slot, value]) => [slot, value.toString("base64")]);
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  };
  const home = await openSecretHome(state.dir, custody);
  if (typeof home === "string") throw new Error("The fixture home is unavailable.");
  const pending = join(home.dir, "authority.next.json");
  const write = custody.write;
  custody.write = async (slot, bytes) => {
    if (phase === "interrupt") {
      state.candidate = JSON.parse(readFileSync(pending, "utf8")).authority;
      persist();
      // End the actual writer process between the pending file and native
      // mutation. This deliberately does not run graceful owner cleanup.
      if (state.interruption === "before-native") process.exit(0);
      throw new Error("Fixture lost the reply without committing a native head.");
    }
    state.writes.push(slot);
    const result = await write(slot, bytes);
    persist();
    return result;
  };
  let confirmations = 0;
  const options = {
    dir: state.dir,
    custody,
    initialize: true,
    environment: () => ({}),
    authentication: {
      available: async () => true,
      confirm: async () => {
        confirmations++;
        return true;
      },
    },
  };
  if (phase === "interrupt") {
    const owner = await ProtectedSecrets.open(options);
    if (owner.availability === "available") {
      const proposal = owner.proposeAuthority({
        rules: [{ id: "unconfirmed", effect: "never", secret: "staging-deploy" }],
        devices: [],
      });
      if (!proposal) throw new Error("No fixture authority.");
      const proof = await owner.confirmAuthority(
        proposal.digest,
        Date.now() + 300_000,
        "Save rules",
      );
      try {
        await owner.saveAuthority(proposal.authority, proof);
      } catch {
        /* The injected lost reply is the scenario, not a successful save. */
      }
    }
    const again = await ProtectedSecrets.open(options);
    return { status: await again.status(), pending: existsSync(pending), writes: state.writes };
  }

  // Neither unreadable case may be mistaken for proof that the head is absent.
  const refusals = [];
  for (const reading of ["locked", "unavailable"] as const) {
    custody.state = reading;
    const refused = await ProtectedSecrets.open(options);
    refusals.push({ status: await refused.status(), pending: existsSync(pending) });
  }
  custody.state = "open";
  const owner = await ProtectedSecrets.open(options);
  const authority = owner.authority();
  const metadata = await owner.metadata();
  const keys = await RootKeys.open(home.custody, { initialize: false, hasRecords: true });
  if (typeof keys === "string") throw new Error("No fixture root after restart.");
  let valueDigest: string | undefined;
  try {
    const value = await new SecretVault(home.dir, keys).open("staging-deploy");
    if (value) {
      try {
        valueDigest = sha256(value.value);
      } finally {
        value.value.fill(0);
      }
    }
  } finally {
    keys.destroy();
  }
  const proposal = owner.proposeAuthority({ rules: [], devices: [] });
  if (!proposal) throw new Error("Restart did not reopen authority.");
  const proof = await owner.confirmAuthority(
    proposal.digest,
    Date.now() + 300_000,
    "Save new rules",
  );
  const saved = await owner.saveAuthority(proposal.authority, proof);
  return {
    status: await owner.status(),
    authority,
    metadata,
    valueDigest,
    saved,
    confirmations,
    pending: existsSync(pending),
    writes: state.writes,
    refusals,
  };
}
