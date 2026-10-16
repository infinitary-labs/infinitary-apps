import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  VOICE_MODEL_FILES,
  VOICE_MODEL_REPO,
  VOICE_MODEL_REVISION,
  VoiceModelService,
} from "./voiceModelService";

function fakeFetch(bytes = 8): { fetchImpl: (url: string) => Promise<Response>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(bytes).fill(7), { status: 200 });
    },
  };
}

describe("VoiceModelService", () => {
  it("downloads exactly the pinned manifest from the pinned revision", async () => {
    const dir = scratchDir("infinitary-voice-");
    const { fetchImpl, urls } = fakeFetch();
    const service = new VoiceModelService(dir, { fetchImpl });
    expect(await service.modelReady()).toBe(false);
    const fractions: number[] = [];
    await service.ensureModel((progress) => fractions.push(progress.fraction));
    expect(await service.modelReady()).toBe(true);
    expect(urls).toHaveLength(VOICE_MODEL_FILES.length);
    for (const url of urls) {
      expect(url).toContain(`${VOICE_MODEL_REPO}/resolve/${VOICE_MODEL_REVISION}/`);
    }
    expect(fractions.at(-1)).toBe(1);
    // Idempotent: nothing re-downloads once present.
    await service.ensureModel();
    expect(urls).toHaveLength(VOICE_MODEL_FILES.length);
  });

  it("never leaves a partial file behind on failure", async () => {
    const dir = scratchDir("infinitary-voice-");
    let calls = 0;
    const service = new VoiceModelService(dir, {
      fetchImpl: async () => {
        calls += 1;
        if (calls > 2) throw new Error("network down");
        return new Response(new Uint8Array(4), { status: 200 });
      },
    });
    await expect(service.ensureModel()).rejects.toThrow("network down");
    expect(await service.modelReady()).toBe(false);
    const files = await readdir(dir, { recursive: true });
    expect(files.filter((file) => String(file).endsWith(".partial"))).toEqual([]);
  });

  it("resolves protocol paths inside the models dir only", async () => {
    const dir = scratchDir("infinitary-voice-");
    const service = new VoiceModelService(dir, fakeFetch());
    expect(service.resolveModelFile("/whisper-large-v3-turbo/config.json")).toBe(
      join(dir, "whisper-large-v3-turbo/config.json"),
    );
    expect(() => service.resolveModelFile("/../outside.txt")).toThrow(/outside/);
    expect(() => service.resolveModelFile("/%2e%2e/outside.txt")).toThrow(/outside/);
  });

  it("writes only manifest files - no audio ever lands on disk (D-13)", async () => {
    const dir = scratchDir("infinitary-voice-");
    const service = new VoiceModelService(dir, fakeFetch());
    await service.ensureModel();
    const entries = (await readdir(dir, { recursive: true })) as string[];
    const files: string[] = [];
    for (const entry of entries) {
      const info = await stat(join(dir, String(entry)));
      if (info.isFile()) files.push(String(entry).replace(/\\/g, "/"));
    }
    expect(files.sort()).toEqual(
      VOICE_MODEL_FILES.map((file) => `whisper-large-v3-turbo/${file}`).sort(),
    );
    // And the content is the fetched model bytes, not anything recorded.
    const sample = await readFile(join(dir, "whisper-large-v3-turbo/config.json"));
    expect([...sample.subarray(0, 2)]).toEqual([7, 7]);
  });

  it("single-flights concurrent downloads", async () => {
    const dir = scratchDir("infinitary-voice-");
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(4).fill(1), { status: 200 }));
    const service = new VoiceModelService(dir, { fetchImpl });
    await Promise.all([service.ensureModel(), service.ensureModel()]);
    expect(fetchImpl).toHaveBeenCalledTimes(VOICE_MODEL_FILES.length);
  });
});
