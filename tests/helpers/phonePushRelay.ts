import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The relay's own words on each card push (docs/phone-push.md), which a push the phone does not open keeps. */
const RELAY_WORDS = "A card is ready";

/**
 * INF-4794: a stand-in for Infinitary's push relay beside the phone test home (docs/phone-push.md). The phone asks
 * it for a grant and the home's real phone sender posts each sealed card to it; it answers as the relay does and
 * hands each card push to the part's simulator as Apple would (`push`). The grant alone comes in its answer, since a
 * simulator delivers no background push. It reads no card: what the home posts stays
 * sealed for the phone, and a simulated push runs no notification part, so the simulator shows the relay's words.
 */
export async function startPhonePushRelay(
  push?: (payload: Record<string, unknown>) => Promise<void>,
) {
  let asks = 0;
  let pushes = 0;
  const problems: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 8192) throw new Error("A relay request is too large");
      }
      const value = JSON.parse(body) as Record<string, unknown>;
      if (typeof value.token !== "string" || !/^(?:[0-9a-f]{2}){32,100}$/.test(value.token))
        throw new Error("A relay request must name a push address");
      if (request.method === "POST" && request.url === "/v1/register") {
        asks += 1;
        // As the relay: a grant for this address, valid for 30 days. The relay sends it by a background push, which
        // a simulator refuses ("Notification has no user visible content"), so this one answers with it instead.
        const expiry = Math.floor(Date.now() / 1000) + 30 * 86_400;
        const grant = `${expiry}.${randomBytes(32).toString("base64url")}`;
        response
          .writeHead(202, { "content-type": "application/json" })
          .end(JSON.stringify({ grant }));
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/push" &&
        typeof value.sealed === "string"
      ) {
        pushes += 1;
        response.writeHead(202).end();
        await push?.({
          aps: { alert: { body: RELAY_WORDS }, sound: "default", "mutable-content": 1 },
          sealed: value.sealed,
        });
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      problems.push((error as Error).message);
      if (!response.headersSent) response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/push`;
  return {
    /** Where the home posts each sealed card; the phone asks for its grant beside it. */
    url,
    state: () => ({ relay: url, words: RELAY_WORDS, asks, pushes, problems: [...problems] }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
