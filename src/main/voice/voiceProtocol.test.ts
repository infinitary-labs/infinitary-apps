import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";

const fixture = vi.hoisted(() => ({ registerFileProtocol: vi.fn() }));
vi.mock("electron", () => ({ protocol: fixture }));

import type { VoiceModelService } from "./voiceModelService";
import { handleVoiceModelProtocol } from "./voiceProtocol";

it("gives Chromium a scoped file with content and CORS headers, and refuses invalid paths", async () => {
  const file = join(scratchDir("infinitary-voice-protocol-"), "config.json");
  const contents = '{"model_type":"whisper"}';
  writeFileSync(file, contents);
  const resolveModelFile = vi.fn((path: string) => {
    if (path !== "/whisper-large-v3-turbo/config.json") throw new Error("invalid path");
    return file;
  });
  handleVoiceModelProtocol({ resolveModelFile } as unknown as VoiceModelService);
  const handler = fixture.registerFileProtocol.mock.calls[0]![1];
  const response = await new Promise<Record<string, unknown>>((resolve) =>
    handler({ url: "app-model://model/whisper-large-v3-turbo/config.json" }, resolve),
  );
  expect(response).toEqual({
    path: file,
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(contents.length),
      "access-control-allow-origin": "*",
    },
  });
  const refused = await new Promise<Record<string, unknown>>((resolve) =>
    handler({ url: "app-model://model/not-the-model" }, resolve),
  );
  expect(refused).toEqual({ statusCode: 404 });
});
