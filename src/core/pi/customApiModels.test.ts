import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CustomApiCatalog, customCapabilities, customCapabilityProfiles } from "./customApiModels";
import { catalogRefreshesSettled } from "./modelRuntime";

/**
 * A user's report: a custom Anthropic connection's Reasoning list stopped at
 * Claude Fable 5.1 while Fable 5.2 was out, because the list read only the
 * catalog bundled with the release (docs/custom-api.md, "Checked reasoning
 * and cache settings"). The list now reads Pi's live catalog for the
 * protocol's own provider too, fetched with no key and kept for the next launch.
 */

/** pi.dev's own Anthropic entry for Claude Fable 5.2, as it answered on 2026-11-17. */
const PI_DEV_FABLE_52 = {
  id: "claude-fable-5-2",
  name: "Claude Fable 5.2",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  contextWindow: 1000000,
  maxTokens: 128000,
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  compat: {
    forceAdaptiveThinking: true,
    supportsMidConvoEffort: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    supportsStrictTools: true,
    allowedFallbackModels: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ],
  },
  promptCache: { short: 300, long: 3600 },
  type: "chat",
};
const PI_DEV_LAST_MODIFIED = "Tue, 17 Nov 2026 09:23:10 GMT";

const servers: Server[] = [];
afterEach(async () => {
  for (const each of servers.splice(0)) {
    each.closeAllConnections();
    await new Promise<void>((resolve) => each.close(() => resolve()));
  }
  await catalogRefreshesSettled();
});

/** A stand-in pi.dev that answers Anthropic's catalog with the entry above, and notes each ask. */
async function standInCatalog(asked: { path: string; authorization?: string }[]): Promise<string> {
  const server = createServer((request, response) => {
    asked.push({ path: request.url ?? "", authorization: request.headers.authorization });
    if (!request.url?.startsWith("/api/models/providers/anthropic")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "last-modified": PI_DEV_LAST_MODIFIED,
    });
    response.end(JSON.stringify([PI_DEV_FABLE_52]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("lists a model only pi.dev's catalog holds, fetched with no key for the connection's protocol", async () => {
  const asked: { path: string; authorization?: string }[] = [];
  const catalogBaseUrl = await standInCatalog(asked);
  const modelsStorePath = join(
    scratchDir("infinitary-custom-catalog-"),
    "custom-catalog-store.json",
  );

  // The release's own catalog stops before Fable 5.2.
  expect(customCapabilityProfiles().map((profile) => profile.id)).not.toContain(
    "anthropic/claude-fable-5-2",
  );

  const source = new CustomApiCatalog({ modelsStorePath, catalogBaseUrl });
  await source.want(["anthropic-messages"]);
  await catalogRefreshesSettled();
  // Only Anthropic's catalog is asked for, and the ask carries no key.
  expect(asked.map(({ path }) => path.split("?")[0])).toEqual(["/api/models/providers/anthropic"]);
  expect(asked.every(({ authorization }) => authorization === undefined)).toBe(true);

  const catalog = source.models();
  expect(customCapabilityProfiles(catalog)).toContainEqual({
    id: "anthropic/claude-fable-5-2",
    label: "Claude Fable 5.2 · anthropic",
    protocol: "anthropic-messages",
    cacheRetentions: ["none", "short", "long"],
  });
  // What Save captures is pi.dev's own reasoning settings, minus its fallback list.
  const { allowedFallbackModels: _, ...compat } = PI_DEV_FABLE_52.compat;
  expect(customCapabilities("anthropic-messages", "anthropic/claude-fable-5-2", catalog)).toEqual({
    profile: "anthropic/claude-fable-5-2",
    reasoning: true,
    thinkingLevelMap: PI_DEV_FABLE_52.thinkingLevelMap,
    compat,
    cacheRetentions: ["none", "short", "long"],
  });
  // The bundled models stay listed beside it.
  expect(customCapabilityProfiles(catalog).map((profile) => profile.id)).toContain(
    "anthropic/claude-fable-5-1",
  );

  // The next launch reads the kept catalog at once, asking nothing within Pi's 4h.
  const next = new CustomApiCatalog({ modelsStorePath, catalogBaseUrl });
  await next.want(["anthropic-messages"]);
  expect(customCapabilityProfiles(next.models()).map((profile) => profile.id)).toContain(
    "anthropic/claude-fable-5-2",
  );
  await catalogRefreshesSettled();
  expect(asked).toHaveLength(1);
});
