import { STANDBY_LOCK_ORDER, type StandbyLock, standbyOrders } from "@shared/standby";
import type { FreshAuthentication } from "../secrets/approvals";
import type { SecretCustody } from "../secrets/custody";
import { type HeldLock, makeLock, readHeldLock } from "./sealedSecrets";

/**
 * What a computer keeps its own lock with (docs/devices.md, "Secrets on a
 * computer that keeps a copy"): a custody item under a name of its own, apart
 * from this computer's own Secrets, and this computer's own confirmation of
 * the person - Touch ID or the password - which alone makes or hands the lock.
 */
export type StandbyLockHost = { custody: SecretCustody; authentication: FreshAuthentication };

/** What the computer's own confirmation dialog says. */
export const STANDBY_LOCK_REASON =
  "Keep your first mate's secrets on this computer, sealed with its own lock.";

/**
 * A computer's side of keeping the first mate's secrets sealed with a copy:
 * the home asks it to keep them, this computer asks the person there once,
 * and only then hands the home its lock's public half. The private half stays
 * in this computer's own custody, which the first mate reads on this computer
 * when it starts here from the copy (`readStandbyLock`).
 */
export class StandbyLockKeeper {
  /** The one request the home made, and where it stands. */
  private current: { request: string; state: StandbyLock } | null = null;

  constructor(
    private readonly host: StandbyLockHost | undefined,
    private readonly log: (line: string) => void,
  ) {}

  async answer(args: unknown): Promise<StandbyLock> {
    const [{ request, ask }] = standbyOrders[STANDBY_LOCK_ORDER].request.parse(args);
    if (this.current?.request === request) return this.current.state;
    if (!ask) return { state: "none", key: null };
    const host = this.host;
    if (!host || !(await host.authentication.available().catch(() => false)))
      return { state: "unavailable", key: null };
    const entry = { request, state: { state: "asking", key: null } as StandbyLock };
    this.current = entry;
    void this.confirm(host).then(
      (state) => {
        if (this.current === entry) entry.state = state;
      },
      (error: unknown) => {
        this.log(
          `keeping secrets failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (this.current === entry) entry.state = { state: "unavailable", key: null };
      },
    );
    return entry.state;
  }

  private async confirm(host: StandbyLockHost): Promise<StandbyLock> {
    let confirmed = false;
    try {
      confirmed = (await host.authentication.confirm(STANDBY_LOCK_REASON)) === true;
    } catch {
      /* A failed or cancelled confirmation keeps nothing. */
    }
    if (!confirmed) return { state: "refused", key: null };
    const held = await readStandbyLock(host.custody);
    if (held === "unavailable") return { state: "unavailable", key: null };
    if (held) return { state: "kept", key: held.publicKey };
    const made = makeLock();
    const bytes = Buffer.from(JSON.stringify(made));
    try {
      if ((await host.custody.write("root", bytes)) !== "stored")
        return { state: "unavailable", key: null };
    } finally {
      bytes.fill(0);
    }
    return { state: "kept", key: made.publicKey };
  }
}

/**
 * This computer's own lock, read from its custody: undefined when it never
 * kept one, unavailable when the store cannot be read now.
 */
export async function readStandbyLock(
  custody: SecretCustody,
): Promise<HeldLock | undefined | "unavailable"> {
  try {
    const read = await custody.read("root");
    if (read.kind === "absent") return undefined;
    if (read.kind !== "value") return "unavailable";
    try {
      return readHeldLock(read.bytes);
    } finally {
      read.bytes.fill(0);
    }
  } catch {
    return "unavailable";
  }
}
