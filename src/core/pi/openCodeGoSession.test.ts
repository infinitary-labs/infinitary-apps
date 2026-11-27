import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { customChatText, sendCustomStream } from "../../../tests/helpers/customApiDialect";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { questionSessionSpec } from "../session/questionSession";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";
import { createPiSessionFactory } from "./session";

/**
 * OpenCode Go refuses a generation request that carries no
 * x-opencode-session (INF-6873). The decision walk's one-shot question
 * session is the session most easily opened without one, so this opens
 * it on an OpenCode Go model, through the account's own runtime with only
 * the provider's address moved to a local stand-in, and reads what arrived.
 */

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await catalogRefreshesSettled();
});

it("sends the question session's ID as x-opencode-session, with the account's own key", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(503);
      response.end();
      return;
    }
    seen.push(request.headers);
    request.resume();
    request.on("end", () => sendCustomStream(response, customChatText("fix")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const dir = scratchDir("infinitary-opencode-go-session-");
  mkdirSync(dir, { recursive: true });
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ "opencode-go": { type: "api_key", key: "sk-pasted-by-the-person" } }),
    { mode: 0o600 },
  );
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { "opencode-go": { baseUrl: base } } }));
  const runtime = await createModelRuntime({ authPath, modelsPath, catalogBaseUrl: base });

  const session = await createPiSessionFactory({ agentDir: join(dir, "agent") }).open(
    questionSessionSpec({
      homeDir: dir,
      binding: { backend: "pi", runtime },
      model: { provider: "opencode-go", id: "kimi-k3" },
      instruction: "Answer with one word.",
    }),
  );
  try {
    await session.prompt("What kind?");
  } finally {
    session.dispose();
  }

  expect(seen).toHaveLength(1);
  const header = seen[0]?.["x-opencode-session"];
  expect(typeof header === "string" && header.length > 0).toBe(true);
  expect(seen[0]?.authorization).toBe("Bearer sk-pasted-by-the-person");
});
