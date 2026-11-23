import { randomUUID } from "node:crypto";
import {
  MEDIA_PROBE_DEADLINE_MS,
  type MediaProbe,
  type MediaProbeResult,
  type TypefaceProbe,
  type TypefaceProbeResult,
} from "@core/pi/cardImages";
import { APP_FRAME_SCHEME } from "@shared/csp";
import { BrowserWindow, session as electronSession, type Session } from "electron";
import { mediaResponse } from "./frames/mediaResponse";
import {
  sanitizerReasons,
  TYPEFACE_WINDOW_MS,
  TYPEFACES_UNANSWERED,
  typefaceScript,
} from "./typefaceProbePage";

/**
 * The host's decoder for a card's demo recording (docs/card-authoring.md
 * "Demo recordings"): before a card goes up, the recording plays in a window
 * of its own - hidden, sandboxed, with no preload and so no app bridge, in an
 * in-memory session that answers nothing but this one recording and refuses
 * every permission, download and network request - and it must show
 * pictures at its start, middle and end within `MEDIA_PROBE_DEADLINE_MS`.
 * The verdict is what Chromium decoded, never what the file says of itself.
 *
 * A preview's project fonts (docs/card-authoring.md "Fonts by reference") are
 * loaded the same way: all of a card's fonts in one window of the same kind,
 * through the same font sanitizer a card's frame uses, each must load as a
 * web font within the same deadline on a clock of its own, and the
 * sanitizer's own message is a refusal's reason (`./typefaceProbePage`).
 *
 * A card's sound clip (docs/card-authoring.md "Sound clips") plays the same
 * way in a page that holds only a muted player: it must load, read a length
 * and seek to its start, middle and end with sound ready at each.
 *
 * Probes run one at a time, recordings and fonts alike, each in a window of
 * its own that is destroyed when it ends, however it ends.
 *
 * The process must have registered the frame scheme's privileges before
 * `app.ready` (`./frames/frameScheme.ts`): the window does that with the
 * shell's other schemes, and the work mode does it when its module loads.
 * Without `standard`, `secure` and `stream`, Chromium rejects the recording
 * and the probe reports that this player cannot play its format.
 */

const PARTITION = "fm-media-probe";
const HOST = "probe";

/** The probe's windows, which are never the app's (`appWindows`). */
const probeWindows = new WeakSet<BrowserWindow>();

export function isMediaProbeWindow(win: BrowserWindow): boolean {
  return probeWindows.has(win);
}

type ProbePage = { html: string; csp: string };

const RECORDING_PAGE: ProbePage = {
  html: "<!doctype html><meta charset=utf-8><video muted playsinline></video>",
  csp: `default-src 'none'; media-src ${APP_FRAME_SCHEME}://${HOST}`,
};

const SOUND_PAGE: ProbePage = {
  html: "<!doctype html><meta charset=utf-8><audio muted></audio>",
  csp: `default-src 'none'; media-src ${APP_FRAME_SCHEME}://${HOST}`,
};

const TYPEFACE_PAGE: ProbePage = {
  html: "<!doctype html><meta charset=utf-8><p>Aa</p>",
  csp: `default-src 'none'; font-src ${APP_FRAME_SCHEME}://${HOST}`,
};

type ProbeFile = { bytes: Buffer; contentType: string };

/**
 * The files the session answers now, each at its one-time name by its
 * place in the list, and their page; nothing else is served.
 */
let current: { token: string; files: readonly ProbeFile[]; page: ProbePage } | undefined;

let prepared: Session | undefined;

function probeSession(): Session {
  if (prepared) return prepared;
  const ses = electronSession.fromPartition(PARTITION, { cache: false });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  // No request leaves the window: only the one file and its page answer.
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith(`${APP_FRAME_SCHEME}://${HOST}/`) });
  });
  ses.protocol.handle(APP_FRAME_SCHEME, async (request) => {
    const url = new URL(request.url);
    const playing = current;
    if (url.host !== HOST || !playing) return new Response(null, { status: 404 });
    if (url.pathname === `/${playing.token}/page`) {
      return new Response(playing.page.html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": playing.page.csp,
          "x-content-type-options": "nosniff",
        },
      });
    }
    const prefix = `/${playing.token}/file/`;
    const index = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    const file = /^\d{1,4}$/.test(index) ? playing.files[Number(index)] : undefined;
    if (!file || request.method !== "GET") return new Response(null, { status: 404 });
    return mediaResponse(
      request.headers.get("range"),
      file.bytes.length,
      file.contentType,
      async ({ start, end }) => new Uint8Array(file.bytes.subarray(start, end + 1)),
    );
  });
  prepared = ses;
  return ses;
}

/**
 * Runs in the probe's page: loads the recording, then seeks to its start,
 * middle and end and draws each picture, so a picture that does not decode
 * is a refusal rather than a blank frame the captain would meet.
 */
const PROBE_SCRIPT = `(async () => {
  const video = document.querySelector("video");
  const fail = (reason) => ({ ok: false, reason });
  const settle = (ok, start) => new Promise((resolve) => {
    const done = (value) => {
      video.removeEventListener(ok, yes);
      video.removeEventListener("error", no);
      resolve(value);
    };
    const yes = () => done(true);
    const no = () => done(false);
    video.addEventListener(ok, yes);
    video.addEventListener("error", no);
    start();
  });
  const why = () => {
    const error = video.error;
    if (!error) return "the player stopped";
    return ["", "loading was stopped", "the file could not be read", "a picture could not be decoded", "this player cannot play its format"][error.code] || "the player failed";
  };
  if (!(await settle("loadeddata", () => { video.src = "RECORDING"; }))) return fail(why());
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return fail("the player read no length from it");
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (const at of [0, duration / 2, Math.max(0, duration - 0.05)]) {
    const seeked = await settle("seeked", () => { video.currentTime = at; });
    const where = at.toFixed(1) + " seconds";
    if (!seeked || video.readyState < 2) return fail("no picture decoded at " + where);
    // A decoded picture is opaque; where none decoded, nothing is drawn.
    // The player can say it holds the picture a moment before its decoder
    // has handed it over to be drawn - a seek to where it already stands is
    // answered at once - so while it still says so, an empty drawing is
    // drawn again; the deadline ends a wait for a picture that never comes.
    for (;;) {
      context.clearRect(0, 0, 8, 8);
      try {
        context.drawImage(video, 0, 0, 8, 8);
      } catch {
        return fail("no picture could be drawn at " + where);
      }
      if (context.getImageData(4, 4, 1, 1).data[3] !== 0) break;
      if (video.error || video.readyState < 2) return fail("no picture decoded at " + where);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (typeof video.webkitDecodedFrameCount === "number" && video.webkitDecodedFrameCount < 1) {
    return fail("no picture decoded");
  }
  return { ok: true, width: video.videoWidth, height: video.videoHeight, durationMs: Math.round(duration * 1000) };
})()`;

/**
 * Runs in the probe's page for a sound clip: loads it, then seeks to its
 * start, middle and end, where the player must hold sound ready to play.
 */
const SOUND_PROBE_SCRIPT = `(async () => {
  const audio = document.querySelector("audio");
  const fail = (reason) => ({ ok: false, reason });
  const settle = (ok, start) => new Promise((resolve) => {
    const done = (value) => {
      audio.removeEventListener(ok, yes);
      audio.removeEventListener("error", no);
      resolve(value);
    };
    const yes = () => done(true);
    const no = () => done(false);
    audio.addEventListener(ok, yes);
    audio.addEventListener("error", no);
    start();
  });
  const why = () => {
    const error = audio.error;
    if (!error) return "the player stopped";
    return ["", "loading was stopped", "the file could not be read", "its sound could not be decoded", "this player cannot play its format"][error.code] || "the player failed";
  };
  if (!(await settle("loadeddata", () => { audio.src = "RECORDING"; }))) return fail(why());
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return fail("the player read no length from it");
  for (const at of [0, duration / 2, Math.max(0, duration - 0.05)]) {
    const seeked = await settle("seeked", () => { audio.currentTime = at; });
    if (!seeked || audio.readyState < 2) return fail("no sound decoded at " + at.toFixed(1) + " seconds");
  }
  return { ok: true, width: 0, height: 0, durationMs: Math.round(duration * 1000) };
})()`;

type Failed = { ok: false; reason: string };

/** What a probe's page answered, or why it could not, and what the page's engine said meanwhile. */
type Probed<T> = { answer: T | Failed; said: string[]; urls: string[] };

async function probeOnce<T extends { ok: boolean }>(
  files: readonly ProbeFile[],
  page: ProbePage,
  script: (urls: string[]) => string,
  late: string,
  deadlineMs: number = MEDIA_PROBE_DEADLINE_MS,
): Promise<Probed<T>> {
  const token = randomUUID();
  current = { token, files, page };
  const ses = probeSession();
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  probeWindows.add(win);
  // A probe is never heard, a sound clip's least of all.
  win.webContents.setAudioMuted(true);
  // What the engine said while it worked, which a refusal names when it is the reason.
  const said: string[] = [];
  win.webContents.on("console-message", (event) => {
    said.push(event.message);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<Failed>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            reason: `${late} within ${deadlineMs / 1000} seconds`,
          }),
        deadlineMs,
      );
    });
    const base = `${APP_FRAME_SCHEME}://${HOST}/${token}`;
    const urls = files.map((_, index) => `${base}/file/${index}`);
    const run = (async (): Promise<T | Failed> => {
      await win.loadURL(`${base}/page`);
      return (await win.webContents.executeJavaScript(script(urls))) as T | Failed;
    })();
    // A run the deadline beat still settles once its window is gone.
    run.catch(() => undefined);
    const answer = await Promise.race([run, deadline]);
    return { answer, said: [...said], urls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { answer: { ok: false, reason }, said: [...said], urls: [] };
  } finally {
    clearTimeout(timer);
    if (current?.token === token) current = undefined;
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Every probe waits for the one before it: the session answers one file at a time. */
let queue: Promise<unknown> = Promise.resolve();

function queued<T>(probe: () => Promise<T>): Promise<T> {
  const run = queue.then(probe);
  queue = run.catch(() => undefined);
  return run;
}

/** The host's `MediaProbe`: one recording or sound clip at a time, each in a window of its own. */
export function createMediaProbe(): MediaProbe {
  return ({ bytes, contentType }) =>
    queued(async () => {
      const sound = contentType.startsWith("audio/");
      return (
        await probeOnce<MediaProbeResult>(
          [{ bytes, contentType }],
          sound ? SOUND_PAGE : RECORDING_PAGE,
          ([url]) => (sound ? SOUND_PROBE_SCRIPT : PROBE_SCRIPT).replace("RECORDING", url ?? ""),
          sound ? "it played no sound" : "it showed no pictures",
        )
      ).answer;
    });
}

/** The host's `TypefaceProbe`: one card's fonts at a time, all in one window of their own. */
export function createTypefaceProbe(): TypefaceProbe {
  return (typefaces) =>
    queued(async () => {
      const { answer, said, urls } = await probeOnce<{ ok: true; loaded: TypefaceProbeResult[] }>(
        typefaces,
        TYPEFACE_PAGE,
        (files) => typefaceScript(files),
        // Each font has its own clock in the page; this one is the window's.
        TYPEFACES_UNANSWERED,
        TYPEFACE_WINDOW_MS,
      );
      if (!answer.ok) return typefaces.map(() => answer);
      const reasons = sanitizerReasons(said, urls);
      return answer.loaded.map((result, index) =>
        result.ok ? result : { ok: false, reason: reasons.get(index) ?? result.reason },
      );
    });
}
