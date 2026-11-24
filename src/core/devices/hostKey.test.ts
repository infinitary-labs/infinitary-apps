import { chmodSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";

// The key read dials the port itself everywhere but on a Mac, so a test reads it as Linux does
// unless it names the system the read runs on.
const on = vi.hoisted(() => ({ platform: "linux", keyscan: null as string | null }));
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  hostPlatform: () => on.platform,
}));
vi.mock("./ssh", async (importOriginal) => {
  const ssh = await importOriginal<typeof import("./ssh")>();
  return {
    ...ssh,
    systemSshTool: (...args: Parameters<typeof ssh.systemSshTool>) =>
      args[0] === "ssh-keyscan" && on.keyscan ? on.keyscan : ssh.systemSshTool(...args),
  };
});

const { readOwnHostKey } = await import("./hostKey");

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  on.platform = "linux";
  on.keyscan = null;
});

/** A port on this computer's loopback where something takes the connection and closes it, sending no SSH key. */
async function notSsh(): Promise<number> {
  const server = createServer((socket) => {
    // The read closes its end once it has its answer, which can reset this side mid-write.
    socket.on("error", () => {});
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const at = server.address();
  if (!at || typeof at === "string") throw new Error("no port");
  return at.port;
}

// INF-6043's change 5: "Could not reach" names the step and port that failed. A Windows
// user's add stopped at the key read with something at port 22 that sent no key.
describe("reading a computer's SSH key", () => {
  it("says the port it read at and that something answered there with no SSH key", async () => {
    const port = await notSsh();
    expect(await readOwnHostKey("127.0.0.1", port)).toEqual({
      refusal: "unreachable",
      reach: { step: "key", port, answered: true },
    });
  });
  // INF-6336: on GitHub's macOS 15 Mac, a Mac's ssh-keyscan read a refused port and said nothing,
  // since its wait can report the refusal as a hang-up, which it ends on without a word
  // (OpenSSH 9.9's ssh-keyscan.c, conloop). The add then said the Mac could not be reached
  // instead of that Remote Login is off there.
  it.skipIf(process.platform === "win32")(
    "on a Mac, says Remote Login is off at a refused port even when ssh-keyscan says nothing",
    async () => {
      on.platform = "darwin";
      on.keyscan = join(scratchDir("infinitary-keyscan-"), "ssh-keyscan");
      writeFileSync(on.keyscan, "#!/bin/sh\nexit 1\n");
      chmodSync(on.keyscan, 0o755);
      expect(await readOwnHostKey("127.0.0.1", await claimedPort())).toEqual({
        refusal: "remote-login-off",
      });
    },
  );
});
