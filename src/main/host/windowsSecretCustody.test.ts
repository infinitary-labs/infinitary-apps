import { describe, expect, it } from "vitest";
import { SECRETS_CUSTODY_NAMES } from "./nativeSecrets";
import { createWindowsSecretCustody, type WindowsCustodyApi } from "./windowsSecretCustody";

// Intent: the captain's answer on INF-4260, "Add Secrets on Windows first, as
// a new piece before piece 11": Windows custody in Credential Manager with no
// plaintext or unprotected fallback, one credential per slot under the
// flavor's name, and what Windows answers is what the owner hears
// (docs/secrets.md, "Native custody").
const NAME = SECRETS_CUSTODY_NAMES.dev;

/** A Credential Manager stand-in that answers with the Windows error each case names. */
function credentials(error?: number) {
  const items = new Map<string, Buffer>();
  const api: WindowsCustodyApi = {
    read: (target) => {
      if (error !== undefined) return { error };
      const bytes = items.get(target);
      return bytes ? { error: 0, bytes: Buffer.from(bytes) } : { error: 1168 };
    },
    write: (target, bytes) => {
      if (error !== undefined) return error;
      items.set(target, Buffer.from(bytes));
      return 0;
    },
  };
  return { api, items };
}

describe("Windows Credential Manager custody", () => {
  it("keeps each slot as its own credential under the flavor's name", async () => {
    const { api, items } = credentials();
    const custody = createWindowsSecretCustody(api, { name: NAME });
    const root = Buffer.alloc(32, 7);
    expect(await custody.read("root")).toEqual({ kind: "absent" });
    expect(await custody.write("root", root)).toBe("stored");
    expect(await custody.write("authority-head", Buffer.from("3:abc"))).toBe("stored");
    expect([...items.keys()]).toEqual([`${NAME}/root`, `${NAME}/authority-head`]);
    expect(await custody.read("root")).toEqual({ kind: "value", bytes: root });
    // The caller's buffer is its own: custody wiped only the copy it handed Windows.
    expect(root.every((byte) => byte === 7)).toBe(true);
  });

  it.each([
    [1312, "unavailable"], // ERROR_NO_SUCH_LOGON_SESSION: a run outside a signed-in session
    [5, "unavailable"], // ERROR_ACCESS_DENIED
    [-1, "unavailable"],
  ] as const)("reports Windows error %i as %s, never absent", async (error, kind) => {
    const custody = createWindowsSecretCustody(credentials(error).api, { name: NAME });
    expect(await custody.read("root")).toEqual({ kind });
    expect(await custody.write("root", Buffer.alloc(32))).toBe(kind);
  });

  it("is unavailable with no binding, and an unknown write outcome rejects", async () => {
    const none = createWindowsSecretCustody(undefined, { name: NAME });
    expect(await none.read("root")).toEqual({ kind: "unavailable" });
    expect(await none.write("root", Buffer.alloc(32))).toBe("unavailable");

    const throwing = createWindowsSecretCustody(
      {
        read: () => {
          throw new Error("binding failed");
        },
        write: () => {
          throw new Error("reply lost");
        },
      },
      { name: NAME },
    );
    expect(await throwing.read("root")).toEqual({ kind: "unavailable" });
    await expect(throwing.write("root", Buffer.alloc(32))).rejects.toThrow(/unknown/);
  });
});
