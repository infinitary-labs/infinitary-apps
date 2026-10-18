import { type ClientRequest, request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { type StubApi, startStubApi } from "./anthropicDialect";

const clients: ClientRequest[] = [];
const apis: StubApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(apis.splice(0).map((api) => api.close()));
});

// INF-360 F3: Pi can close while the API has accepted a request but not its body.
it("closes a Pi API before an incomplete model request finishes arriving", async () => {
  const api = await startStubApi();
  apis.push(api);
  const body = JSON.stringify({
    model: "stub-1",
    messages: [{ role: "user", content: "Check the footer." }],
    tools: [{ name: "look_up" }],
  });
  const client = request(`${api.url}/v1/messages`, {
    method: "POST",
    headers: { "content-length": Buffer.byteLength(body), expect: "100-continue" },
  });
  clients.push(client);
  client.on("error", () => {});
  await new Promise<void>((resolve) => {
    client.once("continue", resolve);
    client.flushHeaders();
  });
  let closed = false;
  client.once("close", () => {
    closed = true;
  });
  await api.close();
  // The close event is a transport witness, not a timing window.
  if (!closed) await new Promise<void>((resolve) => client.once("close", resolve));
  expect(closed).toBe(true);
  expect(api.requests).toEqual([]);
});
