import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { APP_MODEL_SCHEME } from "@shared/csp";
import { type CustomScheme, protocol } from "electron";
import type { VoiceModelService } from "./voiceModelService";

/**
 * The privileged scheme the renderer's Whisper worker loads model files
 * over (hi-bit's pattern), on a Mac where the voice helper cannot run (an
 * Intel Mac; docs/architecture.md section 8). `secure` + `supportFetchAPI` let `fetch()` work
 * from the worker; `standard` gives normal URL parsing so transformers.js
 * can join paths; `corsEnabled` because the renderer origin differs from
 * this scheme.
 */

/** The base transformers.js uses as `env.localModelPath` (scheme + host). */
export const VOICE_MODEL_BASE = `${APP_MODEL_SCHEME}://model`;

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".onnx": "application/octet-stream",
  ".txt": "text/plain",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
}

/**
 * The scheme's privileges, registered before `app.ready` by
 * `registerPrivilegedSchemes` (../schemes.ts) - Electron takes every
 * privileged scheme in one call. Pair with `handleVoiceModelProtocol`
 * after ready.
 */
export const voiceModelScheme: CustomScheme = {
  scheme: APP_MODEL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

/**
 * Serves the on-disk Whisper model to the renderer worker. Requests are
 * scoped to the models dir by `resolveModelFile` (which rejects `..`), so
 * this cannot be turned into an arbitrary file reader. Files stream (the
 * ONNX weights are hundreds of MB) rather than buffer.
 */
export function handleVoiceModelProtocol(service: VoiceModelService): void {
  // A direct file response lets Chromium stream on its file/IO threads.
  // protocol.handle(net.fetch(file)) still relays every chunk through Node.
  protocol.registerFileProtocol(APP_MODEL_SCHEME, (request, callback) => {
    void (async () => {
      try {
        const { pathname } = new URL(request.url);
        const filePath = service.resolveModelFile(pathname);
        const info = await stat(filePath);
        if (!info.isFile()) {
          callback({ statusCode: 404 });
          return;
        }
        callback({
          path: filePath,
          statusCode: 200,
          headers: {
            "content-type": contentTypeFor(filePath),
            "content-length": String(info.size),
            "access-control-allow-origin": "*",
          },
        });
      } catch {
        callback({ statusCode: 404 });
      }
    })();
  });
}
