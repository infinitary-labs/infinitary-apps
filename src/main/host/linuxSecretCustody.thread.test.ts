import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { secretNativeCall } from "./linuxSecretCustody";

// Intent: INF-1109 requires native credential-store calls off the main thread.
// The actual native worker reports its pthread identity; no sleep, credential
// store, system bus, password or platform authentication is involved.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "Secrets native dispatch",
  () => {
    it("executes on a different native thread from its JavaScript caller", async () => {
      const libc = koffi.load(
        process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      );
      // pthread_t is pointer-sized on the two supported platforms.
      const thread = libc.func("uintptr_t pthread_self(void)");
      const caller = thread();
      const worker = await secretNativeCall(thread);
      expect(worker).toBeTypeOf(typeof caller);
      expect(worker).not.toBe(caller);
      expect(worker).not.toBe(0);
      expect(worker).not.toBe(0n);
    });
  },
);
