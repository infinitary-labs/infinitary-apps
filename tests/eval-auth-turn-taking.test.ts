import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

// Two process starts, no model calls, no personal stores. Measured budget recorded in docs.
describe.each(["openai-codex", "xai"])("%s auth turn-taking", (provider) => {
  it("renews exactly once across processes, and both can resolve again", async () => {
    const home = scratchDir("eval-auth-");
    const authPath = join(home, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        [provider]: {
          type: "oauth",
          access: "disposable-old",
          refresh: "single-use-fixture",
          expires: 0,
        },
      }),
    );
    let refreshes = 0;
    const ready: ServerResponse[] = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/ready") {
        ready.push(res);
        if (ready.length === 2) for (const waiter of ready) waiter.end("go");
        return;
      }
      if (req.url !== "/refresh") {
        res.writeHead(404).end();
        return;
      }
      let text = "";
      for await (const chunk of req) text += chunk;
      if (++refreshes !== 1 || JSON.parse(text).refresh !== "single-use-fixture") {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          type: "oauth",
          access: "disposable-new",
          refresh: "rotated-fixture",
          expires: Date.now() + 3_600_000,
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local server");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const children: ReturnType<typeof spawn>[] = [];
    const run = () =>
      new Promise<unknown>((done, fail) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("../src/core/pi/fixtures/resolveAuth.mjs", import.meta.url)),
            authPath,
            endpoint,
            provider,
          ],
          {
            env: hostEnv({
              HOME: home,
              CFFIXED_USER_HOME: home,
              PI_OFFLINE: "1",
              INFINITARY_AUTH_PROOF: "scratch-only",
            }),
          },
        );
        children.push(child);
        let output = "";
        let errors = "";
        child.stdout?.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          errors += chunk;
        });
        child.on("error", fail);
        child.on("exit", (code) =>
          code === 0 ? done(JSON.parse(output)) : fail(new Error(errors)),
        );
      });
    try {
      expect(await Promise.all([run(), run()])).toEqual([
        { resolved: true, later: true },
        { resolved: true, later: true },
      ]);
      expect(refreshes).toBe(1);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
