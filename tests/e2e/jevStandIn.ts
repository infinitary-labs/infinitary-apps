import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { DECISION_APPROVAL_VERSION } from "../../src/shared/decisionUses";

/**
 * A stand-in for Jev, the native decision model (docs/decision-models.md):
 * it answers each question the app sends with the option `choose` names, at
 * a high confidence, and abstains on every other question (a confidence of
 * zero), so the app's own fallback decides it as with no decision model.
 * `asked` keeps each question's id, the facts it came with and the number
 * of the request that held it, counted from 1.
 */
export type JevStandIn = {
  url: string;
  asked: { id: string; state: Record<string, unknown>; request: number }[];
  close: () => Promise<void>;
};

type Question = { criteria: Record<string, string> };

export async function startJevStandIn(
  choose: (id: string, options: string[], state: Record<string, unknown>) => string | undefined,
): Promise<JevStandIn> {
  const server: Server = createServer();
  const asked: JevStandIn["asked"] = [];
  let requests = 0;
  server.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        state: Record<string, unknown>;
        questions: Record<string, Question>;
      };
      requests += 1;
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          asked.push({ id, state: body.state, request: requests });
          const options = Object.keys(question.criteria);
          const named = choose(id, options, body.state);
          const choice = named ?? options[0] ?? "";
          const confidence = named ? 0.95 : 0;
          return [
            id,
            { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
          ];
        }),
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 412, output_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Puts Jev on answering decisions, through the channels the Decisions form drives. */
export async function answerDecisionsWithJev(page: Page): Promise<void> {
  await page.evaluate(
    (key) => window.infinitary.models.setDecisionKey("jev", key),
    "ts-live-e2e-0000000000",
  );
  await page.evaluate(
    (version) =>
      window.infinitary.models.setDecisions({
        version: 1,
        answerer: { kind: "native", id: "jev" },
        egress: { jev: { enabled: true, consentedVersion: version } },
      }),
    DECISION_APPROVAL_VERSION,
  );
}
