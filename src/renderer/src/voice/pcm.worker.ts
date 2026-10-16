import { framesToMono16k, isAudioSilent } from "./voiceInput";

export type PcmRequest =
  | { type: "init"; sampleRate: number; maxPreRoll: number }
  | { type: "frame"; frame: Float32Array }
  | { type: "begin" }
  | { type: "end" };
export type PcmClip = { samples: Float32Array; silent: boolean };

const ctx = self as unknown as {
  onmessage: (event: MessageEvent<PcmRequest>) => void;
  postMessage(message: PcmClip, transfer: Transferable[]): void;
};
let sampleRate = 48000;
let maxPreRoll = 0;
let preRoll: Float32Array[] = [];
let preRollSamples = 0;
let capturing = false;
let captured: Float32Array[] = [];

ctx.onmessage = ({ data }) => {
  switch (data.type) {
    case "init":
      sampleRate = data.sampleRate;
      maxPreRoll = data.maxPreRoll;
      break;
    case "frame":
      if (capturing) {
        captured.push(data.frame);
      } else {
        preRoll.push(data.frame);
        preRollSamples += data.frame.length;
        while (preRollSamples > maxPreRoll && preRoll.length > 0) {
          preRollSamples -= preRoll.shift()?.length ?? 0;
        }
      }
      break;
    case "begin":
      captured = [...preRoll];
      capturing = true;
      break;
    case "end": {
      capturing = false;
      const samples = framesToMono16k(captured, sampleRate);
      captured = [];
      preRoll = [];
      preRollSamples = 0;
      ctx.postMessage({ samples, silent: isAudioSilent(samples) }, [samples.buffer]);
      break;
    }
  }
};
