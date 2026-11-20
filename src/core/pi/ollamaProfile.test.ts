import { describe, expect, it, vi } from "vitest";
import { ollamaContext, prepareOllama } from "./ollamaProfile";

const endpoint = { baseUrl: "http://local.test/v1", model: "qwen3.5:9b", apiKey: "test-only" };
function fixture(
  options: {
    maximum?: number;
    fits?: number;
    conflict?: boolean;
    createFails?: boolean;
    version?: string;
  } = {},
) {
  const aliases = new Map<string, number>();
  const original = {
    modelfile: "FROM /models/sha256-original\nPARAMETER temperature 0.7",
    parameters: "temperature 0.7\nnum_ctx 4096",
    model_info: {
      "general.architecture": "qwen35",
      "qwen35.context_length": options.maximum ?? 262144,
    },
    capabilities: ["tools", "vision", "thinking"],
  };
  let loaded: { name: string; context_length: number; size: number; size_vram: number } | undefined;
  let digest = "original-digest";
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, body });
    const answer = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (path.endsWith("/version")) return answer({ version: options.version ?? "0.34.2" });
    if (path.endsWith("/tags"))
      return answer({
        models: [
          { name: endpoint.model, digest },
          ...[...aliases.keys()].map((name) => ({ name, digest: "alias-digest" })),
        ],
      });
    if (path.endsWith("/show")) {
      if (
        body.model === endpoint.model ||
        body.model === `registry.ollama.ai/library/${endpoint.model}`
      )
        return answer(original);
      const context = aliases.get(body.model);
      return context
        ? answer({
            ...original,
            parameters: `num_ctx ${options.conflict ? 4096 : context}\ntemperature 0.7`,
          })
        : answer({ error: "missing" }, 404);
    }
    if (path.endsWith("/create")) {
      if (options.createFails) return answer({ error: "denied" }, 403);
      expect(String(body.from).replace(/^registry\.ollama\.ai\/library\//, "")).toBe(
        endpoint.model,
      );
      expect(body.model).not.toBe(endpoint.model);
      aliases.set(body.model, body.parameters.num_ctx);
      return answer({ status: "success" });
    }
    if (path.endsWith("/chat")) {
      expect(body.model).not.toBe(endpoint.model);
      if (body.keep_alive !== 0) {
        expect(body.messages).toEqual([]);
        expect(body.shift).toBe(false);
        expect(body.truncate).toBe(false);
      }
      const context = aliases.get(body.model) ?? 0;
      loaded =
        body.keep_alive === 0
          ? undefined
          : {
              name: body.model,
              context_length: context,
              size: 100,
              size_vram: context <= (options.fits ?? 65536) ? 100 : 40,
            };
      return answer({ done: true });
    }
    if (path.endsWith("/ps")) return answer({ models: loaded ? [loaded] : [] });
    if (path.endsWith("/delete")) {
      aliases.delete(body.model);
      return answer({ status: "success" });
    }
    throw new Error(`Unexpected ${path}`);
  }) as typeof fetch;
  return {
    fetcher,
    requests,
    aliases,
    updateBase: () => {
      digest = "updated-digest";
    },
  };
}

describe("Ollama context preparation", () => {
  it("creates once, reads serving num_ctx (not the trained maximum), reuses, and refreshes on a base-tag update", async () => {
    const f = fixture();
    const first = await prepareOllama(endpoint, f.fetcher);
    expect(first).toMatchObject({ contextWindow: 65536, vision: true, thinking: true });
    expect((await prepareOllama(endpoint, f.fetcher))?.alias).toBe(first?.alias);
    expect(f.requests.filter((r) => r.path.endsWith("/create"))).toHaveLength(1);
    f.updateBase();
    expect((await prepareOllama(endpoint, f.fetcher))?.alias).not.toBe(first?.alias);
    expect(f.aliases.size).toBe(2);
    expect(f.requests.filter((r) => r.path.endsWith("/delete"))).toHaveLength(0);
  });
  it("refuses rather than shrinking below 64K when the server allocation spills to CPU", async () => {
    const f = fixture({ fits: 32768, maximum: 131072 });
    await expect(prepareOllama(endpoint, f.fetcher)).rejects.toThrow("graphics memory");
    expect(f.aliases.size).toBe(0);
  });
  it("bounds the request by the trained maximum", async () => {
    const f = fixture({ maximum: 70000 });
    expect((await prepareOllama(endpoint, f.fetcher))?.contextWindow).toBe(65536);
  });
  it("does not overwrite or delete a conflicting existing alias", async () => {
    const f = fixture({ conflict: true });
    await expect(prepareOllama(endpoint, f.fetcher)).rejects.toThrow("does not match");
    await expect(prepareOllama(endpoint, f.fetcher)).rejects.toThrow("does not match");
    expect(f.requests.filter((r) => r.path.endsWith("/create"))).toHaveLength(1);
    expect(f.requests.filter((r) => r.path.endsWith("/delete"))).toHaveLength(0);
  });
  it("reports creation failures without falling back or exposing an internal alias", async () => {
    const f = fixture({ createFails: true });
    await expect(prepareOllama(endpoint, f.fetcher)).rejects.toThrow("prepare the local model");
    expect(f.requests.some((r) => r.path.endsWith("/chat"))).toBe(false);
  });
  it("refuses a model too small for the contract before making any changes", async () => {
    const f = fixture({ maximum: 16384 });
    await expect(prepareOllama(endpoint, f.fetcher)).rejects.toThrow("cannot hold");
    expect(f.aliases.size).toBe(0);
  });
  it("leaves non-Ollama endpoints alone, but does not hide an unreachable endpoint", async () => {
    const generic = vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch;
    expect(await prepareOllama(endpoint, generic)).toBeUndefined();
    const offline = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(prepareOllama(endpoint, offline)).rejects.toThrow("could not reach");
  });
  it("normalizes explicit default registry names without changing the user's base tag", async () => {
    const f = fixture();
    const first = await prepareOllama(endpoint, f.fetcher);
    const full = await prepareOllama(
      { ...endpoint, model: `registry.ollama.ai/library/${endpoint.model}` },
      f.fetcher,
    );
    expect(full?.alias).toBe(first?.alias);
  });
  it("refuses older servers before creating anything rather than trusting ignored flags", async () => {
    const f = fixture({ version: "0.34.1" });
    await expect(prepareOllama(endpoint, f.fetcher)).rejects.toThrow("0.34.2 or newer");
    expect(f.aliases.size).toBe(0);
  });
  it("parses the actual parameter line, never another number or the trained limit", () => {
    expect(ollamaContext("temperature 0.7\nnum_ctx 32768\nnum_predict 8192")).toBe(32768);
    for (const value of [
      "",
      "num_ctx -1",
      "num_ctx 0",
      "# num_ctx 65536",
      "num_ctx 1.5",
      "num_ctx 32768abc",
    ])
      expect(ollamaContext(value)).toBeUndefined();
  });
});
