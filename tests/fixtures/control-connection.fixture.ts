import { createServer } from "node:http";
import { keepControlConnection } from "../helpers/budgets.ts";

// INF-886: the phone baseline lost its second keyboard-before-launch POST when
// the frozen disposable home expired a reused connection before reading it.
let requests = 0;
const server = createServer((_request, response) => {
  process.send?.({ request: ++requests });
  response.end(JSON.stringify({ generation: requests }));
  if (requests === 1)
    response.once("finish", () =>
      setImmediate(() => {
        process.send?.({ stopped: true });
        process.kill(process.pid, "SIGSTOP");
      }),
    );
});
const idleBudget = server.keepAliveTimeout + server.keepAliveTimeoutBuffer;
keepControlConnection(server);
server.listen(0, "127.0.0.1", () => {
  process.send?.({ port: (server.address() as { port: number }).port, idleBudget });
});
process.once("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.disconnect());
});
