import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { VoiceDownloadProgress } from "@shared/voice";
import { WHISPER_MODEL_ID } from "@shared/voiceRecognizer";

/** The transformers.js model id; also the on-disk folder name under `modelsDir`. */
export const VOICE_MODEL_ID = WHISPER_MODEL_ID;
/** The HuggingFace repo the ONNX weights come from. */
export const VOICE_MODEL_REPO = "onnx-community/whisper-large-v3-turbo";
/**
 * Pinned revision so the downloaded file set stays deterministic even if the
 * repo's `main` changes (docs/architecture.md section 8). Bump deliberately
 * if the manifest below needs to move.
 */
export const VOICE_MODEL_REVISION = "360ebcde2559d60bb474678be3c1de9ef347d01a";

/**
 * Exactly the files transformers.js requests for this model on WebGPU with
 * `dtype: { encoder_model: "fp16", decoder_model_merged: "q4" }`. The
 * encoder fp16 weight is self-contained (no external `.onnx_data`). Keep in
 * sync with `WHISPER_PIPELINE_OPTIONS` (@shared/voiceRecognizer).
 */
export const VOICE_MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_fp16.onnx",
  "onnx/decoder_model_merged_q4.onnx",
] as const;

type FetchImpl = (url: string) => Promise<Response>;

type VoiceModelDeps = {
  fetchImpl?: FetchImpl;
};

/**
 * Owns the on-disk Whisper model: knows whether it is
 * fully present, downloads it once from the pinned HuggingFace revision into
 * `userData/models/`, and resolves `app-model://` requests to safe on-disk
 * paths. Only the main process touches the network; the voice helper reads
 * the files from disk, and the window's worker (an Intel Mac) over the
 * protocol, and neither fetches. Voice audio itself never
 * touches this service - or any disk (decision D-13).
 */
export class VoiceModelService {
  private readonly fetchImpl: FetchImpl;
  // One shared download at a time; concurrent callers await the same run.
  private inFlight: Promise<void> | null = null;
  private readonly progressListeners = new Set<(progress: VoiceDownloadProgress) => void>();

  constructor(
    private readonly modelsDir: string,
    deps: VoiceModelDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? ((url) => fetch(url));
  }

  modelDir(): string {
    return join(this.modelsDir, VOICE_MODEL_ID);
  }

  async modelReady(): Promise<boolean> {
    for (const file of VOICE_MODEL_FILES) {
      try {
        const info = await stat(join(this.modelDir(), file));
        if (!info.isFile() || info.size === 0) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Maps an `app-model://` request pathname to an absolute path under
   * `modelsDir`, refusing anything that would escape it via `..`.
   */
  resolveModelFile(requestPath: string): string {
    const rel = decodeURIComponent(requestPath).replace(/^[/\\]+/, "");
    const root = resolve(this.modelsDir);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error("Refusing to serve a path outside the models dir.");
    }
    return abs;
  }

  /**
   * Downloads any missing manifest files from the pinned revision. Each file
   * streams to a `.partial` sibling and renames only on success, so an
   * interrupted download never leaves a half-file that `modelReady()` would
   * wrongly accept. Single-flight.
   */
  async ensureModel(onProgress?: (progress: VoiceDownloadProgress) => void): Promise<void> {
    if (onProgress) this.progressListeners.add(onProgress);
    try {
      if (!this.inFlight) {
        this.inFlight = this.runDownload().finally(() => {
          this.inFlight = null;
        });
      }
      await this.inFlight;
    } finally {
      if (onProgress) this.progressListeners.delete(onProgress);
    }
  }

  private emitProgress(progress: VoiceDownloadProgress): void {
    for (const listener of this.progressListeners) listener(progress);
  }

  private async runDownload(): Promise<void> {
    const missing: string[] = [];
    for (const file of VOICE_MODEL_FILES) {
      try {
        const info = await stat(join(this.modelDir(), file));
        if (info.isFile() && info.size > 0) continue;
      } catch {}
      missing.push(file);
    }
    if (missing.length === 0) return;

    for (let i = 0; i < missing.length; i++) {
      const file = missing[i] as string;
      await this.downloadFile(file, (fileFraction) => {
        this.emitProgress({
          file,
          fileIndex: i,
          fileCount: missing.length,
          fraction: (i + fileFraction) / missing.length,
        });
      });
      this.emitProgress({
        file,
        fileIndex: i,
        fileCount: missing.length,
        fraction: (i + 1) / missing.length,
      });
    }
  }

  private async downloadFile(
    file: string,
    onFileProgress: (fraction: number) => void,
  ): Promise<void> {
    const url = `https://huggingface.co/${VOICE_MODEL_REPO}/resolve/${VOICE_MODEL_REVISION}/${file}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Could not download ${file} (HTTP ${response.status}).`);
    }

    const target = join(this.modelDir(), file);
    const partial = `${target}.partial`;
    await mkdir(dirname(target), { recursive: true });

    try {
      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body?.getReader();
      if (reader) {
        const handle = await open(partial, "w");
        try {
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              await handle.write(value);
              received += value.byteLength;
              if (total > 0) onFileProgress(Math.min(1, received / total));
            }
          }
        } finally {
          await handle.close();
        }
      } else {
        await writeFile(partial, Buffer.from(await response.arrayBuffer()));
      }
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    onFileProgress(1);
  }
}
