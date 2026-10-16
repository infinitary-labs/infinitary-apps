import {
  RecognizerClient,
  type RecognizerPlace,
  type RecognizerResponse,
  recognizerPlaceFor,
  type SpeechAbilityRequest,
  type SpeechAbilityResponse,
  type StartRecognizer,
} from "@shared/voiceRecognizer";
import { utilityProcess } from "electron";
import { hasGraphicsCard } from "./graphicsCard";

/** The slice of a forked utility process the voice helper uses. */
export type VoiceHelperProcess = {
  postMessage: (message: unknown) => void;
  on: (
    event: "message",
    listener: (message: RecognizerResponse | SpeechAbilityResponse) => void,
  ) => void;
  once: (event: "exit", listener: (code: number) => void) => void;
  kill: () => boolean;
};

export type VoiceHelperOptions = {
  /** The built helper entry (out/main/voiceHelper.js, from ./voiceHelperEntry.ts). */
  entryPath: string;
  /** Where the downloaded model lives (userData/models). */
  modelsDir: string;
  /** Electron's `utilityProcess.fork` in the app; a stand-in in tests. */
  fork?: (entryPath: string, args: string[]) => VoiceHelperProcess;
};

const forkUtility = (entryPath: string, args: string[]): VoiceHelperProcess =>
  utilityProcess.fork(entryPath, args, {
    serviceName: "Infinitary Voice",
    stdio: "inherit",
  });

/**
 * Starts the voice helper process: Whisper in a process of its own, so the
 * model's graphics work and memory stay out of the window and out of the
 * process that draws every window frame. Recordings reach it in messages,
 * in memory only (D-13).
 */
export function voiceHelperStarter(options: VoiceHelperOptions): StartRecognizer {
  const fork = options.fork ?? forkUtility;
  return (events) => {
    const child = fork(options.entryPath, [options.modelsDir]);
    let exited = false;
    child.on("message", (message) => {
      if (message.type !== "ability") events.message(message);
    });
    child.once("exit", () => {
      exited = true;
      events.failed(new Error("The voice helper stopped working."));
    });
    return {
      post: (request) => {
        if (exited) throw new Error("The voice helper stopped working.");
        child.postMessage(request);
      },
      stop: () => {
        if (!exited) child.kill();
      },
    };
  };
}

/**
 * The voice helper as the main process holds it: started on the first
 * recording, ended after three idle minutes, started again on the next.
 */
export function createVoiceHelper(options: VoiceHelperOptions): RecognizerClient {
  return new RecognizerClient(voiceHelperStarter(options));
}

/** How long the helper has to say what its library can do before the window's recognizer stands in. */
export const SPEECH_ABILITY_TIMEOUT_MS = 10_000;

/**
 * Asks the voice helper what its speech library can do on this computer
 * (`SpeechAbilityRequest`): a helper started for this one question and ended
 * once it answers, which loads the library and opens no graphics device.
 * Resolves the providers the library lists, or null where it has no build
 * here, the helper stopped, or it did not answer in time.
 */
export function askSpeechAbility(
  options: VoiceHelperOptions,
  timeoutMs = SPEECH_ABILITY_TIMEOUT_MS,
): Promise<string[] | null> {
  const fork = options.fork ?? forkUtility;
  return new Promise((resolve) => {
    let child: VoiceHelperProcess | null = null;
    let settled = false;
    const settle = (providers: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill();
      resolve(providers);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    try {
      child = fork(options.entryPath, [options.modelsDir]);
    } catch {
      settle(null);
      return;
    }
    const question: SpeechAbilityRequest = { id: 0, type: "ability" };
    child.on("message", (message) => {
      if (message.type === "ability" && message.id === question.id) settle(message.providers);
    });
    child.once("exit", () => settle(null));
    child.postMessage(question);
  });
}

/**
 * Where this computer transcribes (docs/architecture.md section 8, "Where
 * speech runs"), from what it can do rather than which system it is
 * (`recognizerPlaceFor`): settled once per run, on the first ask. A computer
 * with no graphics card settles it without starting anything; otherwise the
 * voice helper says what its library lists.
 */
export function speechPlace(options: VoiceHelperOptions): () => Promise<RecognizerPlace> {
  let place: Promise<RecognizerPlace> | null = null;
  return () => {
    place ??= (async () => {
      const graphicsCard = hasGraphicsCard();
      const providers = graphicsCard ? await askSpeechAbility(options) : null;
      return recognizerPlaceFor({ providers, graphicsCard });
    })();
    return place;
  };
}
