import { randomUUID } from "node:crypto";
import {
  MEDIA_PROBE_DEADLINE_MS,
  type MediaProbe,
  type MediaProbeResult,
} from "@core/pi/cardImages";
import { APP_FRAME_SCHEME } from "@shared/csp";
import { BrowserWindow, session as electronSession, type Session } from "electron";
import { mediaResponse } from "./frames/mediaResponse";

/**
 * The host's decoder for a card's demo recording (docs/card-authoring.md
 * "Demo recordings"): before a card goes up, the recording plays in a window
 * of its own - hidden, sandboxed, with no preload and so no app bridge, in an
 * in-memory session that answers nothing but this one recording and refuses
 * every permission, download and network request - and it must show
 * pictures at its start, middle and end within `MEDIA_PROBE_DEADLINE_MS`.
 * The verdict is what Chromium decoded, never what the file says of itself.
 *
 * Probes run one at a time, each in a window of its own that is destroyed
 * when it ends, however it ends.
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

/** The recording the session answers now, at its one-time name; nothing else is served. */
let current: { token: string; bytes: Buffer; contentType: string } | undefined;

let prepared: Session | undefined;

function probeSession(): Session {
  if (prepared) return prepared;
  const ses = electronSession.fromPartition(PARTITION, { cache: false });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  // No request leaves the window: only the one recording and its page answer.
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith(`${APP_FRAME_SCHEME}://${HOST}/`) });
  });
  ses.protocol.handle(APP_FRAME_SCHEME, async (request) => {
    const url = new URL(request.url);
    const playing = current;
    if (url.host !== HOST || !playing) return new Response(null, { status: 404 });
    if (url.pathname === `/${playing.token}/page`) {
      return new Response("<!doctype html><meta charset=utf-8><video muted playsinline></video>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; media-src ${APP_FRAME_SCHEME}://${HOST}`,
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (url.pathname !== `/${playing.token}/recording` || request.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    return mediaResponse(
      request.headers.get("range"),
      playing.bytes.length,
      playing.contentType,
      async ({ start, end }) => new Uint8Array(playing.bytes.subarray(start, end + 1)),
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

async function probeOnce(bytes: Buffer, contentType: string): Promise<MediaProbeResult> {
  const token = randomUUID();
  current = { token, bytes, contentType };
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
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<MediaProbeResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            reason: `it showed no pictures within ${MEDIA_PROBE_DEADLINE_MS / 1000} seconds`,
          }),
        MEDIA_PROBE_DEADLINE_MS,
      );
    });
    const base = `${APP_FRAME_SCHEME}://${HOST}/${token}`;
    const run = (async (): Promise<MediaProbeResult> => {
      await win.loadURL(`${base}/page`);
      const answer = (await win.webContents.executeJavaScript(
        PROBE_SCRIPT.replace("RECORDING", `${base}/recording`),
      )) as MediaProbeResult;
      return answer;
    })();
    // A run the deadline beat still settles once its window is gone.
    run.catch(() => undefined);
    return await Promise.race([run, deadline]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    if (current?.token === token) current = undefined;
    if (!win.isDestroyed()) win.destroy();
  }
}

/** The host's `MediaProbe`: one recording at a time, each in a window of its own. */
export function createMediaProbe(): MediaProbe {
  let queue: Promise<unknown> = Promise.resolve();
  return ({ bytes, contentType }) => {
    const run = queue.then(() => probeOnce(bytes, contentType));
    queue = run.catch(() => undefined);
    return run;
  };
}
