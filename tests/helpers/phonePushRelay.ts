import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The relay's own words on each card push (docs/phone-push.md), which a push the phone does not open keeps. */
const RELAY_WORDS = "A card is ready";

/** A letter box: 32 bytes in base64url. */
const BOX = /^[A-Za-z0-9_-]{43}$/;

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
  // INF-5275: the newest letter in each box, as the relay keeps it (docs/phone-push.md, "Letters").
  const boxes = new Map<string, string>();
  const problems: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 8192) throw new Error("A relay request is too large");
      }
      const value = JSON.parse(body) as Record<string, unknown>;
      // A computer reads its box with the box alone, as the relay asks: the letter waiting, or 204 for none.
      if (request.method === "POST" && request.url === "/v1/letter/read") {
        if (typeof value.box !== "string" || !BOX.test(value.box))
          throw new Error("A letter read must name a box");
        const sealed = boxes.get(value.box);
        if (sealed === undefined) response.writeHead(204).end();
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ sealed }));
        return;
      }
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
      if (request.method === "POST" && request.url === "/v1/letter") {
        if (typeof value.box !== "string" || !BOX.test(value.box))
          throw new Error("A letter must name a box");
        if (typeof value.grant !== "string" || typeof value.environment !== "string")
          throw new Error("A letter must carry the phone's grant");
        if (
          typeof value.sealed !== "string" ||
          value.sealed.length === 0 ||
          value.sealed.length > 1024
        )
          throw new Error("A letter must be sealed and short");
        boxes.set(value.box, value.sealed);
        response.writeHead(204).end();
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
    state: () => ({
      relay: url,
      words: RELAY_WORDS,
      asks,
      pushes,
      letters: boxes.size,
      problems: [...problems],
    }),
    /** Whether a letter waits in this box. */
    holds: (box: string) => boxes.has(box),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
