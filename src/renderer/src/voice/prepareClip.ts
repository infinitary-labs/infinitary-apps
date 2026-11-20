import type { PcmClip, PcmRequest } from "./pcm.worker";

/** Owns PCM off the window thread; release sends one constant-size message, not a clip-sized buffer list. */
export class ClipPreparer {
  private readonly worker = new Worker(new URL("./pcm.worker.ts", import.meta.url), {
    type: "module",
  });
  private startupError: Error | null = null;

  constructor(sampleRate: number, maxPreRoll: number) {
    this.worker.onerror = (event) => {
      this.startupError = new Error(event.message || "The recording could not be prepared.");
    };
    this.send({ type: "init", sampleRate, maxPreRoll });
  }

  private send(message: PcmRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  push(frame: Float32Array): void {
    this.send({ type: "frame", frame }, [frame.buffer]);
  }

  begin(): void {
    this.send({ type: "begin" });
  }

  close(): void {
    this.worker.terminate();
  }

  prepare(): Promise<PcmClip> {
    if (this.startupError) {
      this.close();
      return Promise.reject(this.startupError);
    }
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<PcmClip>) => {
        this.close();
        resolve(event.data);
      };
      this.worker.onerror = (event) => {
        this.close();
        reject(new Error(event.message || "The recording could not be prepared."));
      };
      try {
        this.send({ type: "end" });
      } catch (error) {
        this.close();
        reject(error);
      }
    });
  }
}
