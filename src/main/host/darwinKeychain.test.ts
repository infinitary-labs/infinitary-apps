import { describe, expect, it } from "vitest";
import type { TrustedToolRead } from "./claudeKeychainTool";
import {
  createDarwinKeychain,
  type DarwinKeychainApi,
  type DarwinPresence,
  mapFind,
  mapRead,
  SEC_ITEM_NOT_FOUND,
} from "./darwinKeychain";

function stubApi(control: {
  findStatus?: number;
  presence?: Omit<DarwinPresence, "status">;
  read?: { status: number; value?: string };
  interaction?: boolean[];
  calls?: string[];
}): DarwinKeychainApi {
  const interaction: boolean[] = control.interaction ?? [];
  return {
    setUserInteractionAllowed: (allowed) => {
      interaction.push(allowed);
      control.calls?.push(`interaction:${allowed}`);
    },
    findGenericPassword: () => {
      control.calls?.push("presence");
      return { status: control.findStatus ?? 0, ...control.presence };
    },
    readGenericPassword: () => {
      control.calls?.push("read");
      return control.read ?? { status: 0, value: "secret" };
    },
  };
}

const QUERY = { service: "Claude Code-credentials", account: "kun" } as const;
const STORE = "/Users/kun/Library/Keychains/login.keychain-db";

describe("darwin Keychain host mapping", () => {
  it("maps errSecItemNotFound to absent, never a failed miss", () => {
    expect(mapFind({ status: SEC_ITEM_NOT_FOUND })).toEqual({ kind: "absent" });
    expect(mapRead({ status: SEC_ITEM_NOT_FOUND })).toEqual({ kind: "absent" });
    expect(mapFind({ status: 0, modifiedAt: "20260915183000Z" })).toEqual({
      kind: "found",
      modifiedAt: "20260915183000Z",
    });
    expect(mapRead({ status: 0, value: "tok" })).toEqual({ kind: "value", value: "tok" });
  });

  it("a host-capability failure keeps its OSStatus, never looks absent", async () => {
    const keychain = createDarwinKeychain(stubApi({ findStatus: -25308, interaction: [] }));
    const presence = await keychain.findGenericPassword({
      service: "Claude Code-credentials",
      account: "kun",
    });
    expect(presence).toEqual({
      kind: "failed",
      code: -25308,
      message: "User interaction is not allowed.",
    });
    expect(presence.kind).not.toBe("absent");
  });

  it("VALUE reads may raise the grant dialog only when interactive", async () => {
    const interaction: boolean[] = [];
    const keychain = createDarwinKeychain(
      stubApi({ read: { status: 0, value: "tok" }, interaction }),
    );
    await keychain.readGenericPassword({
      service: "Claude Code-credentials",
      account: "kun",
    });
    expect(interaction.at(-1)).toBe(false);
    await keychain.readGenericPassword({
      service: "Claude Code-credentials",
      account: "kun",
      interactive: true,
    });
    expect(interaction.at(-1)).toBe(true);
    await keychain.findGenericPassword({
      service: "Claude Code-credentials",
      account: "kun",
      interactive: true,
    });
    // Presence never raises the grant dialog, even if a caller sets interactive.
    expect(interaction.at(-1)).toBe(false);
  });
});

describe("darwin Keychain host: a locked store", () => {
  it("presence says whether the store is locked, and never hands out its file", () => {
    expect(mapFind({ status: 0, locked: true, keychainPath: STORE })).toEqual({
      kind: "found",
      locked: true,
    });
    expect(mapFind({ status: 0, locked: false, keychainPath: STORE })).toEqual({
      kind: "found",
      locked: false,
    });
  });

  it("offers no unlock without a helper to run it", () => {
    expect(createDarwinKeychain(stubApi({})).unlockKeychain).toBeUndefined();
  });

  it("hands the item's store to the helper after a silent presence probe", async () => {
    const calls: string[] = [];
    const paths: string[] = [];
    const keychain = createDarwinKeychain(
      stubApi({ presence: { locked: true, keychainPath: STORE }, calls }),
      async (path) => {
        paths.push(path);
        calls.push("helper");
        return 0;
      },
    );
    expect(await keychain.unlockKeychain?.({ ...QUERY, interactive: true })).toEqual({
      kind: "unlocked",
    });
    expect(paths).toEqual([STORE]);
    // This process stays silent: the dialog is the helper's to show.
    expect(calls).toEqual(["interaction:false", "presence", "helper"]);
  });

  it("never runs the helper for a background caller", async () => {
    let ran = false;
    const keychain = createDarwinKeychain(
      stubApi({ presence: { locked: true, keychainPath: STORE } }),
      async () => {
        ran = true;
        return 0;
      },
    );
    expect(await keychain.unlockKeychain?.(QUERY)).toEqual({
      kind: "failed",
      code: -25308,
      message: "User interaction is not allowed.",
    });
    expect(ran).toBe(false);
  });

  it("does not ask when the store is already unlocked", async () => {
    let ran = false;
    const keychain = createDarwinKeychain(
      stubApi({ presence: { locked: false, keychainPath: STORE } }),
      async () => {
        ran = true;
        return 0;
      },
    );
    expect(await keychain.unlockKeychain?.({ ...QUERY, interactive: true })).toEqual({
      kind: "unlocked",
    });
    expect(ran).toBe(false);
  });

  it("uses Apple's tool only after the one item's access rules allow it", async () => {
    const reads: string[] = [];
    const readTrusted = async (account: string, keychainPath: string): Promise<TrustedToolRead> => {
      reads.push(`${account}:${keychainPath}`);
      return { kind: "value", value: "token" };
    };
    const denied = createDarwinKeychain(
      stubApi({
        read: { status: -25293 },
        presence: { locked: false, keychainPath: STORE },
      }),
      undefined,
      readTrusted,
    );
    expect(await denied.readGenericPassword(QUERY)).toEqual({
      kind: "failed",
      code: -25293,
      message: "Auth failed.",
    });
    expect(reads).toEqual([]);

    const allowed = createDarwinKeychain(
      {
        ...stubApi({
          read: { status: -25293 },
          presence: { locked: false, keychainPath: STORE },
        }),
        claudeItemTrustsAppleTool: () => true,
      },
      undefined,
      readTrusted,
    );
    expect(await allowed.readGenericPassword(QUERY)).toEqual({ kind: "value", value: "token" });
    expect(reads).toEqual([`kun:${STORE}`]);
  });

  it("reports the helper's refusal and a helper that could not answer, never as unlocked", async () => {
    const cancelled = createDarwinKeychain(
      stubApi({ presence: { locked: true, keychainPath: STORE } }),
      async () => -128,
    );
    expect(await cancelled.unlockKeychain?.({ ...QUERY, interactive: true })).toEqual({
      kind: "failed",
      code: -128,
      message: "User canceled the request.",
    });
    const crashed = createDarwinKeychain(
      stubApi({ presence: { locked: true, keychainPath: STORE } }),
      async () => {
        throw new Error("The unlock helper exited (1) without an answer.");
      },
    );
    expect(await crashed.unlockKeychain?.({ ...QUERY, interactive: true })).toEqual({
      kind: "failed",
      message: "The unlock helper exited (1) without an answer.",
    });
    const missing = createDarwinKeychain(
      stubApi({ findStatus: SEC_ITEM_NOT_FOUND }),
      async () => 0,
    );
    expect(await missing.unlockKeychain?.({ ...QUERY, interactive: true })).toMatchObject({
      kind: "failed",
      code: SEC_ITEM_NOT_FOUND,
    });
  });
});
