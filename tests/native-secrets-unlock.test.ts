import {
  chmodSync,
  linkSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { answerKeychainRequest } from "../src/main/host/keychainProcessRuntime";
import {
  FIXTURE_PURPOSE,
  FIXTURE_SERVICE,
  fixtureUnlockReader,
} from "./fixtures/native-secrets/unlock";
import { scratchDir } from "./helpers/scratchDirs";

// Intent: the Secrets fixture must keep its explicit, owned-store unlock after
// main moved native calls into the shared child lifecycle; no default-store search.
// Real disposable filesystem readings own isolation; the native unlock call stands in.
function fixture() {
  const root = realpathSync(scratchDir("secrets-unlock-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(join(home, "Library/Keychains"), { recursive: true });
  chmodSync(home, 0o700);
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ purpose: FIXTURE_PURPOSE }));
  const store = join(home, "Library/Keychains/secrets-proof.keychain-db");
  writeFileSync(store, "The native dialog stands in; no saved passwords exist here.", {
    mode: 0o600,
  });
  const unlock = vi.fn(() => 0);
  const load = vi.fn(() => ({ unlockKeychain: unlock }));
  const reader = fixtureUnlockReader(root, load);
  const ask = (interactive = true, service = FIXTURE_SERVICE) =>
    answerKeychainRequest(
      reader,
      JSON.stringify({ operation: "unlock", query: { service, interactive } }),
    );
  return { root, home, store, unlock, load, reader, ask };
}

it("uses the current child protocol to unlock only the fixed owned store", async () => {
  const f = fixture();
  expect(await f.ask()).toEqual({ kind: "unlocked" });
  expect(f.unlock).toHaveBeenCalledExactlyOnceWith(f.store);
  // Existing sign-ins stay absent even inside the disposable helper.
  expect(
    await answerKeychainRequest(
      f.reader,
      JSON.stringify({ operation: "read", query: { service: FIXTURE_SERVICE } }),
    ),
  ).toEqual({ kind: "absent" });
  expect(f.unlock).toHaveBeenCalledTimes(1);
});

it("does not load native code without the exact explicit fixture request", async () => {
  const f = fixture();
  expect(await f.ask(false)).toMatchObject({ kind: "failed" });
  expect(await f.ask(true, "Claude Code-credentials")).toMatchObject({ kind: "failed" });
  expect(f.load).not.toHaveBeenCalled();
});

it.each(["symlink", "hardlink", "public-home", "wrong-owner"] as const)(
  "refuses a %s before opening a native store",
  async (changed) => {
    const f = fixture();
    if (changed === "symlink") {
      renameSync(f.store, `${f.store}.original`);
      symlinkSync(`${f.store}.original`, f.store);
    } else if (changed === "hardlink") linkSync(f.store, `${f.store}.link`);
    else if (changed === "public-home") chmodSync(f.home, 0o755);
    else
      writeFileSync(join(f.root, "fixture.json"), JSON.stringify({ purpose: "another-fixture" }));
    expect(await f.ask()).toMatchObject({ kind: "failed" });
    expect(f.load).not.toHaveBeenCalled();
  },
);

it("preserves cancellation and a failed native call without retry", async () => {
  const f = fixture();
  // errSecUserCanceled, the same native outcome the dialog reader preserves.
  f.unlock.mockReturnValueOnce(-128);
  expect(await f.ask()).toMatchObject({ kind: "failed", code: -128 });
  expect(f.unlock).toHaveBeenCalledTimes(1);
  f.unlock.mockImplementationOnce(() => {
    throw new Error("The native call ended without an answer.");
  });
  expect(await f.ask()).toMatchObject({ kind: "failed" });
  expect(f.unlock).toHaveBeenCalledTimes(2);
});
