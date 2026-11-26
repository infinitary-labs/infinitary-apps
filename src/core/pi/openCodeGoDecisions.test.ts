import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { OPENCODE_GO_PROVIDER_ID } from "@shared/providers";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { classifyWithProvider, decisionModelsOf } from "./decisionModels";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";
import { withOpenCodeGoDecisions } from "./openCodeGoDecisions";

// Intent: the approved plan for OpenCode Go's decision models - add them in
// Infinitary through a wrap of Pi's opencode-go provider until Pi lists them,
// reached at Go's decision address under the Go key and priced at list price.

it("lists Go's decision models on the Go account and asks them under the Go key", async () => {
  const dir = scratchDir("infinitary-opencode-go-decisions-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ [OPENCODE_GO_PROVIDER_ID]: { type: "api_key", key: "fake-go-key" } }),
  );
  const seen: { url?: string; bearer?: string; model?: unknown }[] = [];
  const server = createServer((request, response) => {
    // The runtime's background catalog refresh stays on this server too.
    if (request.method === "GET") {
      response.writeHead(503);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      seen.push({
        url: request.url,
        bearer: request.headers.authorization,
        model: (JSON.parse(body) as { model?: unknown }).model,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: {
            kind: { type: "choice", choice: "fix", probabilities: { fix: 0.9 }, confidence: 0.9 },
          },
          usage: { input_tokens: 1000, output_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const runtime = await createModelRuntime({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      catalogBaseUrl: base,
    });
    const jev = decisionModelsOf(runtime, OPENCODE_GO_PROVIDER_ID).find(
      (model) => model.id === "jev-1.14",
    );
    expect(jev).toEqual({
      id: "jev-1.14",
      name: "Jev 1.14",
      vendor: "TypeSafe",
      inputPrice: 0.042,
    });
    expect(
      runtime
        .getModelsOfType("classifier", OPENCODE_GO_PROVIDER_ID)
        .find((model) => model.id === "jev-1.14")?.baseUrl,
    ).toBe("https://opencode.ai/inference/go/systemone/v1");
    // A decision model never joins the chat models routing places.
    expect(runtime.getAvailableSnapshot().some((model) => model.id === "jev-1.14")).toBe(false);
    const call = await classifyWithProvider(
      runtime,
      OPENCODE_GO_PROVIDER_ID,
      "jev-1.14",
      {
        state: { title: "Fix the clock" },
        questions: {
          kind: {
            type: "choice",
            instructions: "What kind?",
            criteria: { fix: "fix", chore: "chore" },
          },
        },
      },
      new AbortController().signal,
      15_000,
      `${base}/inference/go/systemone/v1`,
    );
    expect(seen).toEqual([
      {
        url: "/inference/go/systemone/v1/systemone",
        bearer: "Bearer fake-go-key",
        model: "jev-1.14",
      },
    ]);
    expect(call?.result.stopReason).toBe("stop");
    expect(call?.served).toBe("jev-1.14.0");
    // 1,000 input tokens at $0.042 per million, Go's list price.
    expect(call?.usage?.cost).toBeCloseTo(0.000042);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await catalogRefreshesSettled();
  }
});

it("keeps Go's decision models callable once Pi's catalog lists one, and steps aside for a provider that classifies", () => {
  const listed = {
    type: "classifier",
    id: "jev-1.14",
    name: "Jev 1.14 from the catalog",
    provider: OPENCODE_GO_PROVIDER_ID,
  };
  const listing = {
    id: OPENCODE_GO_PROVIDER_ID,
    getModels: () => [],
    getAllModels: () => [listed],
  } as unknown as Provider;
  const wrapped = withOpenCodeGoDecisions(listing);
  expect(wrapped.classify).toBeTypeOf("function");
  expect(
    wrapped
      .getAllModels?.()
      .filter((model) => model.type === "classifier")
      .map((model) => model.name),
  ).toEqual(["Jev 1.14 from the catalog", "GPT-6 Luna Decision", "Gemini Decision 1"]);
  const classifying = { ...listing, classify: () => undefined } as unknown as Provider;
  expect(withOpenCodeGoDecisions(classifying)).toBe(classifying);
});
