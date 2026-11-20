import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { expect, it } from "vitest";
import { keepControlConnection } from "./helpers/budgets";

// INF-886 / the captain's quiet-run-grades choice: a disposable control server's
// idle budget must not reset a phone POST queued while its owned process is frozen.
async function frozenConnection(grades: boolean) {
  const child = fork(join(__dirname, "fixtures/control-connection.fixture.ts"), [], {
    env: { ...process.env, INFINITARY_PERF_BUDGETS: grades ? "1" : "0" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  const ready = once(child, "message");
  const requests: number[] = [];
  const stopped = new Promise<void>((resolve) => {
    child.on("message", (message: { stopped?: boolean; request?: number }) => {
      if (message.request) requests.push(message.request);
      if (message.stopped) resolve();
    });
  });
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const [{ port, idleBudget }] = (await ready) as [{ port: number; idleBudget: number }];
    const connection = connect(port, "127.0.0.1");
    socket = connection;
    let output = "";
    connection.on("data", (data) => {
      output += data.toString();
    });
    const closed = new Promise<string>((resolve) => {
      connection.on("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code ?? error.message),
      );
      connection.on("close", () => resolve("closed"));
    });
    await once(connection, "connect");
    connection.write(
      "POST /keyboard-before-launch HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n",
    );
    await stopped;
    // Deliberate load, not a pass/fail window: hold past Node's actual idle budget.
    await pause(idleBudget + 1_000);
    await new Promise<void>((resolve) =>
      connection.write(
        "POST /keyboard-before-launch HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        () => resolve(),
      ),
    );
    child.kill("SIGCONT");
    const result = { closed: await closed, responses: (output.match(/200 OK/g) ?? []).length };
    // IPC can deliver after the socket; closing the fixture drains its messages.
    child.kill("SIGTERM");
    await exited;
    return { ...result, requests };
  } finally {
    child.kill("SIGCONT");
    child.kill("SIGTERM");
    socket?.destroy();
    await exited;
  }
}

// INF-886: headroom must not turn an unused control connection into an endless wait.
it("closes an idle disposable control connection at a finite safety deadline", async () => {
  const server = createServer((_request, response) => response.end("complete"));
  server.keepAliveTimeout = 50;
  server.keepAliveTimeoutBuffer = 0;
  keepControlConnection(server);
  const signal = AbortSignal.timeout(5_000);
  let connection: ReturnType<typeof connect> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The control server has no port");
    connection = connect(address.port, "127.0.0.1");
    let response = "";
    connection.on("data", (data) => {
      response += data.toString();
    });
    const closed = once(connection, "close", { signal });
    await once(connection, "connect", { signal });
    connection.write("GET /state HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
    await closed;
    expect(response).toContain("200 OK");
    expect(response).toContain("complete");
    console.log("Idle control connection closed after its finite safety deadline");
  } finally {
    connection?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps a frozen control connection ordinarily and retains its idle limit when graded", async () => {
  const [ordinary, graded] = await Promise.all([frozenConnection(false), frozenConnection(true)]);
  console.log("frozen control POSTs", { ordinary, graded });
  expect(ordinary).toEqual({ closed: "closed", responses: 2, requests: [1, 2] });
  expect(graded).toEqual({ closed: "ECONNRESET", responses: 1, requests: [1] });
}, 20_000);
