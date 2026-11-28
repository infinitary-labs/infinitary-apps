import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { waitCap } from "../../../tests/helpers/budgets";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import { forkChildProcess } from "./forkChildProcess";

// Batch #154: a pending AXI reply can reach Node before the parent sees IPC close.
it("survives a reply after the peer closes IPC but before the parent sees it", async () => {
  const entry = join(scratchDir("infinitary-fork-close-"), "command.cjs");
  writeFileSync(
    entry,
    `const net = require('node:net');
     const server = net.createServer(socket => {
       server.close();
       process.once('disconnect', () => socket.end('peer disconnected'));
       process.disconnect();
     });
     server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));`,
  );
  const child = forkChildProcess(entry).spawn();
  const ready = deferred<string>();
  const exit = deferred<number | null>();
  child.onExit(exit.resolve);
  child.onMessage((message) => {
    try {
      const { port } = message as { port: number };
      // Keep the parent's event loop in this turn until the separate socket confirms closure.
      const marker = execFileSync(
        process.execPath,
        [
          "-e",
          "require('node:net').connect(+process.argv[1], '127.0.0.1').pipe(process.stdout)",
          String(port),
        ],
        { env: hostEnv(), encoding: "utf8", timeout: waitCap(5_000) },
      );
      child.postMessage({ type: "result", id: 1, reply: { kind: "ok" } });
      ready.resolve(marker);
    } catch (error) {
      ready.reject(error);
    }
  });
  try {
    const marker = await Promise.race([
      ready.promise,
      exit.promise.then(() => {
        throw new Error("Command exited before the reply was attempted");
      }),
    ]);
    expect(marker).toBe("peer disconnected");
    const exitCode = await exit.promise;
    console.info(
      "Late fork reply proof",
      JSON.stringify({ marker, replyAttempted: true, exitCode }),
    );
  } finally {
    child.kill();
    await exit.promise;
  }
});
