import { setTimeout as delay } from "node:timers/promises";
import {
  FORM_RESEND,
  type HostBrowserCookies,
  type HostBrowserOpen,
  type HostBrowserPage,
  type HostBrowserViewport,
  type HostLoadOutcome,
  type HostPageEvents,
} from "@core/host";
import {
  type AskGrants,
  endAsks,
  layOut,
  type ProtocolPage,
  pageSend,
  pageStorage,
  prepareProtocolPage,
  protocolCommands,
  protocolMessage,
  protocolState,
  screencast,
} from "../pageProtocol";
import type { CdpPipe } from "./cdpPipe";

/**
 * One task page in Google Chrome (docs/task-browser.md, "Installed browser engines"): a tab of the task's own empty Chrome context, driven over
 * Chrome's protocol through the page's flattened session. What every engine
 * does the same comes from `../pageProtocol.ts`; this file re-makes over the
 * protocol what the built-in engine gets from Electron: the core's `allow`
 * on every request, the guard's sign-in, refusals, navigation and loads.
 */

/** How long a load the page started on its own is waited for. */
const SETTLE_MS = 10_000;
/** A screenshot must finish before the browser command's overall deadline. */
const CAPTURE_MS = 5_000;

async function withinCapture<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(abort.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the browser window did not answer the screenshot")),
          CAPTURE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** Chrome's own name for a failed load, as the built-in engine names it (`ERR_...`). */
export function loadCode(errorText: string): string {
  return errorText.replace(/^net::/, "");
}

function outcomeOf(wait: LoadWait): HostLoadOutcome {
  const code = wait.certificate ?? wait.failed;
  return code ? { ok: false, code } : { ok: true };
}

export type ChromePageInput = {
  pipe: CdpPipe;
  sessionId: string;
  targetId: string;
  events: HostPageEvents;
  /** The browser's policy, proxy and refusals: its first page's open. */
  open: HostBrowserOpen;
  viewport: HostBrowserViewport;
  cookies: HostBrowserCookies;
  clipboardText: () => string;
  /** What the page's browser was let use (docs/task-browser.md, "A site's asks"). */
  grants: AskGrants;
  /** Bring the page's own window forward, or put it back in the Dock. */
  restoreForCapture: boolean;
  showWindow: (shown: boolean) => Promise<void>;
  /** How the page goes: its whole browser for the first page, its tab for a second one. */
  close: () => void;
};

export type ChromePage = {
  page: HostBrowserPage;
  /** An event from this page's session or a frame or worker attached under it. */
  message: (method: string, params: Record<string, unknown>, sessionId: string) => void;
  /** A worker of the page's browser Chrome attached on its own: its requests are this page's to judge. */
  adopt: (sessionId: string) => void;
  /** Chrome changed the page's address or title. */
  info: (info: { url?: string; title?: string }) => void;
  /** The page went without the core closing it: crashed, closed in Chrome, or Chrome is gone. */
  gone: (reason: string) => void;
  /** A page another page opened closed itself, as a bank's check does once answered. */
  closedItself: () => void;
  /** Whether a frame id is one of this page's, for a download it started. */
  hasFrame: (frameId: string) => boolean;
  /** Settles once Chrome has answered every command that prepared the page; fails if one failed. */
  prepared: Promise<void>;
  /** Let the page run, once the engine hears its events. */
  run: () => Promise<void>;
  /** What an expression reads in the page's own document, as the built-in engine's page answers it. */
  evaluate: (expression: string) => Promise<unknown>;
};

/** How long pointer input waits for a frame before it goes anyway: a page Chrome stopped drawing still takes it. */
const FRAME_WAIT_MS = 1_000;

type LoadWait = {
  resolve: (outcome: HostLoadOutcome) => void;
  failed?: string;
  /** A certificate that did not verify ended the load: Chrome then calls it aborted. */
  certificate?: string;
};

/**
 * Make a page Chrome has attached and holds before its first document
 * runs: hear its requests and prepare it as every engine does. The engine
 * lets it run once it hears the page's events (`run`).
 */
export async function driveChromePage(input: ChromePageInput): Promise<ChromePage> {
  const { pipe, sessionId, targetId, events, open } = input;
  // No session is the page's own document, as on the built-in engine; a
  // frame from another site is reached through its own.
  const shared: ProtocolPage = {
    sendTo: <T = Record<string, unknown>>(
      method: string,
      params?: Record<string, unknown>,
      to?: string,
    ): Promise<T> => pipe.send<T>(method, params ?? {}, to ?? sessionId),
    events,
    onRefused: open.onRefused,
    grants: input.grants,
    alive: () => !closed,
    clipboardText: input.clipboardText,
  };
  const send = pageSend(shared);
  // A frame Chrome could not prepare stays held: its preparation is what
  // holds its own frames and workers for the core.
  const state = protocolState(shared, input.viewport, true);
  let closed = false;
  let url = "";
  let title = "";
  // Chrome tells a target's title only now and then, so the page's own title
  // is read once its document is in and again when it finishes loading.
  const readTitle = (): void => {
    void send("Runtime.evaluate", { expression: "document.title", returnByValue: true })
      .then((answer) => {
        const value = (answer as { result?: { value?: unknown } }).result?.value;
        if (typeof value === "string" && value) title = value;
      })
      .catch(() => undefined);
  };
  let lastNav = "";
  let loading = false;
  let lastStatus: number | undefined;
  // The last document request's method, and whether the page answers a sent form.
  let documentMethod = "GET";
  let formAnswer = false;
  // Whether Chrome tells the page of a certificate error before it ends the request.
  let certificatesHeard = false;
  const frames = new Set<string>([targetId]);
  const documents = new Set<string>();
  const requestUrls = new Map<string, string>();
  const loadWaits = new Set<LoadWait>();
  const watchAgain = (): void => {
    if (state.watcher) screencast(send, state);
  };
  const stopped = (): void => {
    loading = false;
    for (const wait of [...loadWaits]) {
      loadWaits.delete(wait);
      wait.resolve(outcomeOf(wait));
    }
  };
  /**
   * Resolves when the page stops loading, with how the top frame's load
   * ended; with a bound, no later than that. A load the crewmate asked for
   * has none, as the built-in engine's has none.
   */
  const nextLoad = (bound?: number): Promise<HostLoadOutcome> =>
    new Promise((resolve) => {
      const wait: LoadWait = {
        resolve: (outcome) => {
          if (timer) clearTimeout(timer);
          resolve(outcome);
        },
      };
      const timer =
        bound === undefined
          ? undefined
          : setTimeout(() => {
              loadWaits.delete(wait);
              resolve(outcomeOf(wait));
            }, bound);
      loadWaits.add(wait);
    });

  /** A request of this page, a frame or a worker under it: the core's `allow`, then on or refused. */
  const paused = (params: Record<string, unknown>, from: string): void => {
    const request = params.request as { url: string; method: string };
    const top = params.resourceType === "Document" && params.frameId === targetId;
    const requestId = String(params.requestId);
    // Every frame and worker under this page shares its top-level address.
    if (!open.allow({ url: request.url, topLevel: top, ...(url ? { page: url } : {}) })) {
      void pipe
        .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, from)
        .catch(() => undefined);
      return;
    }
    if (top) documentMethod = request.method;
    void pipe.send("Fetch.continueRequest", { requestId }, from).catch(() => undefined);
  };

  /**
   * A sign-in Chrome asks for: the guard's, answered with this browser's own
   * sign-in, or a site's own sign-in box, refused and told to the core.
   */
  const authRequired = (params: Record<string, unknown>, from: string): void => {
    const requestId = String(params.requestId);
    const challenge = params.authChallenge as { source?: string; origin?: string };
    const request = params.request as { url: string };
    const proxy = open.proxy;
    const guard =
      challenge.source === "Proxy" && challenge.origin === `http://${proxy.host}:${proxy.port}`;
    void pipe
      .send(
        "Fetch.continueWithAuth",
        {
          requestId,
          authChallengeResponse: guard
            ? { response: "ProvideCredentials", username: proxy.username, password: proxy.password }
            : { response: "CancelAuth" },
        },
        from,
      )
      .catch(() => undefined);
    if (challenge.source === "Server") open.onRefused({ kind: "sign-in-box", url: request.url });
  };

  /**
   * A worker runs once its requests are heard and the workers it starts are
   * held as it is; one that could not be prepared stays held, so nothing it
   * asks for skips the core. A dedicated worker's requests are heard by the
   * frame that started it, since Chrome pauses none in the worker itself.
   */
  const hold = (worker: string, dedicated = false): Promise<unknown> =>
    (dedicated ? Promise.resolve() : intercept(worker))
      .then(() =>
        pipe.send(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          worker,
        ),
      )
      .then(() => pipe.send("Runtime.runIfWaitingForDebugger", {}, worker));

  /** Hear a session's requests and sign-ins: this page's own, or a frame's or worker's under it. */
  const intercept = (from: string): Promise<unknown> =>
    pipe.send(
      "Fetch.enable",
      { handleAuthRequests: true, patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      from,
    );

  const message = (method: string, params: Record<string, unknown>, from: string): void => {
    if (method === "Fetch.requestPaused") {
      paused(params, from);
      return;
    }
    if (method === "Fetch.authRequired") {
      authRequired(params, from);
      return;
    }
    const frame = from === sessionId ? undefined : from;
    if (method === "Target.attachedToTarget") {
      // A frame in another process, or a worker: its requests are asked of
      // the core too, before it runs. A frame is then prepared as the page
      // is, which holds its own frames and workers the same way; a worker
      // holds the workers it starts.
      // One whose requests could not be heard stays held.
      const child = String(params.sessionId);
      const info = params.targetInfo as { type?: string } | undefined;
      if (info?.type === "iframe") {
        void intercept(child)
          .then(() => state.frames.onEvent(method, params, frame))
          .catch(() => undefined);
      } else {
        void hold(child, info?.type === "worker").catch(() => undefined);
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      void state.frames.onEvent(method, params, frame).catch(() => undefined);
      return;
    }
    if (protocolMessage(shared, state, method, params, frame)) {
      if (method === "Network.requestWillBeSent") {
        const request = params.request as { url: string };
        const id = String(params.requestId);
        requestUrls.set(id, request.url);
        if (params.type === "Document" && params.frameId === targetId) documents.add(id);
      } else if (method === "Network.responseReceived") {
        const id = String(params.requestId);
        if (documents.has(id)) {
          const response = params.response as { status: number };
          lastStatus = response.status > 0 ? response.status : undefined;
        }
      } else if (method === "Network.loadingFailed") {
        const id = String(params.requestId);
        const failed = String(params.errorText ?? "");
        const at = requestUrls.get(id) ?? "";
        if (!certificatesHeard && failed.startsWith("net::ERR_CERT_")) {
          open.onRefused({ kind: "certificate", url: at, code: failed });
        }
        if (documents.has(id) && params.canceled !== true) {
          for (const wait of loadWaits) wait.failed = loadCode(failed);
          // A load that failed answers a form only if it was one.
          formAnswer = documentMethod === "POST";
        }
        requestUrls.delete(id);
        documents.delete(id);
      }
      return;
    }
    // The rest is the page's own: a frame's or a worker's tells nothing more.
    if (frame) return;
    if (method === "Network.loadingFinished") {
      const id = String(params.requestId);
      requestUrls.delete(id);
      documents.delete(id);
      return;
    }
    if (method === "Page.frameAttached") {
      frames.add(String(params.frameId));
      return;
    }
    if (method === "Page.frameDetached") {
      if (params.frameId !== targetId) frames.delete(String(params.frameId));
      return;
    }
    if (method === "Page.frameStartedLoading") {
      if (params.frameId === targetId) loading = true;
      return;
    }
    if (method === "Page.frameStoppedLoading") {
      if (params.frameId === targetId) stopped();
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = params.frame as {
        id: string;
        parentId?: string;
        url: string;
        urlFragment?: string;
        unreachableUrl?: string;
      };
      frames.add(frame.id);
      if (frame.parentId || frame.id !== targetId) return;
      // Chrome's own page for a load that failed is no new document of the
      // site's: the built-in engine reports none either.
      if (frame.unreachableUrl) {
        url = frame.unreachableUrl;
        events.onLoadFailed(url);
        return;
      }
      url = `${frame.url}${frame.urlFragment ?? ""}`;
      // A redirect that changes POST to GET is an ordinary page again.
      formAnswer = documentMethod === "POST";
      // A full load is a new document even at the same address, so refs from
      // before a reload are gone.
      lastNav = url;
      events.onNavigated(url);
      watchAgain();
      return;
    }
    if (method === "Page.navigatedWithinDocument") {
      if (params.frameId !== targetId) return;
      // A same-document move is told as a move; the same address twice is one move.
      const next = String(params.url);
      url = next;
      readTitle();
      if (next === lastNav) return;
      lastNav = next;
      events.onNavigated(next);
      return;
    }
    if (method === "Page.domContentEventFired") {
      readTitle();
      return;
    }
    if (method === "Page.loadEventFired") {
      readTitle();
      watchAgain();
      return;
    }
    if (method === "Security.certificateError") {
      // Never past a certificate error: the request ends, with no page of
      // Chrome's offering to go on anyway.
      void send("Security.handleCertificateError", {
        eventId: params.eventId,
        action: "cancel",
      }).catch(() => undefined);
      const at = String(params.requestURL ?? "");
      const code = String(params.errorType ?? "ERR_CERT_INVALID");
      if ([...documents].some((id) => requestUrls.get(id) === at)) {
        for (const wait of loadWaits) wait.certificate = code;
      }
      open.onRefused({
        kind: "certificate",
        url: at,
        code: `net::${code}`,
      });
      return;
    }
    if (method === "Inspector.targetCrashed") {
      gone("crashed");
    }
  };

  const gone = (reason: string): void => {
    if (closed) return;
    closed = true;
    state.watcher = undefined;
    endAsks(state);
    stopped();
    events.onGone(reason);
  };
  const closedItself = (): void => {
    if (closed) return;
    closed = true;
    state.watcher = undefined;
    endAsks(state);
    stopped();
    events.onClosed();
  };

  // Every command that prepares the page goes now, in order, and none waits
  // for its answer: Chrome answers some only once the page runs, as a page a
  // form opened with its answer does, and the page runs only after them
  // (`run`), so each still takes effect before its first request.
  const sent: Promise<unknown>[] = [];
  const queued: ProtocolPage = {
    ...shared,
    sendTo: <T = Record<string, unknown>>(
      method: string,
      params?: Record<string, unknown>,
      to?: string,
    ): Promise<T> => {
      sent.push(shared.sendTo(method, params, to));
      return Promise.resolve({} as T);
    },
  };
  const queue = pageSend(queued);
  sent.push(intercept(sessionId));
  // A frame in another process and a worker are held until their requests are heard.
  await prepareProtocolPage(queued, state);
  void queue("Inspector.enable");
  // A certificate that does not verify comes here first, so the request ends
  // before Chrome draws its page that offers to go on anyway. A Chrome
  // without that command still never goes on: its failed load is told.
  void queue("Security.enable");
  sent.push(
    send("Security.setOverrideCertificateErrors", { override: true })
      .then(() => {
        certificatesHeard = true;
      })
      .catch(() => undefined),
  );
  const prepared = Promise.all(sent).then(() => undefined);
  // The engine waits for it once the page runs; until then a failure waits too.
  prepared.catch(() => undefined);

  const commands = protocolCommands(shared, state);
  // Two frames: the one in flight, then one drawn with the document as it is now.
  const drawn = (): Promise<unknown> =>
    Promise.race([
      send("Runtime.evaluate", {
        expression:
          "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))",
        awaitPromise: true,
      }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, FRAME_WAIT_MS)),
    ]);
  const page: HostBrowserPage = {
    cookies: input.cookies,
    storage: pageStorage(send, true, async (origin) => {
      await send("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage" });
    }),
    session: pageStorage(send, false, async () => undefined),
    url: () => url,
    title: () => title,
    load: async (next) => {
      lastStatus = undefined;
      const done = nextLoad();
      let answer: { errorText?: string; loaderId?: string };
      try {
        answer = await send<{ errorText?: string; loaderId?: string }>("Page.navigate", {
          url: next,
        });
      } catch (error) {
        stopped();
        return { ok: false, code: error instanceof Error ? error.message : String(error) };
      }
      if (answer.errorText) {
        stopped();
        const outcome = await done;
        return outcome.ok ? { ok: false, code: loadCode(answer.errorText) } : outcome;
      }
      // A move within the document loads nothing.
      if (!answer.loaderId) stopped();
      const outcome = await done;
      if (!outcome.ok) return outcome;
      return lastStatus === undefined ? { ok: true } : { ok: true, status: lastStatus };
    },
    history: async (direction) => {
      const { currentIndex, entries } = await send<{
        currentIndex: number;
        entries: { id: number }[];
      }>("Page.getNavigationHistory");
      const entry = entries[direction === "back" ? currentIndex - 1 : currentIndex + 1];
      if (!entry) return { ok: false, code: "no-history" };
      const done = nextLoad(SETTLE_MS);
      await send("Page.navigateToHistoryEntry", { entryId: entry.id });
      return done;
    },
    reload: async () => {
      if (formAnswer) return { ok: false, code: FORM_RESEND };
      const done = nextLoad(SETTLE_MS);
      await send("Page.reload");
      return done;
    },
    settle: async () => {
      if (closed || !loading) return;
      await nextLoad(SETTLE_MS);
    },
    ...commands,
    capture: async (options) => {
      if (!input.restoreForCapture) return withinCapture(() => commands.capture(options));
      // On Linux an iconified window still sends screencast frames, but may
      // never answer a PNG capture. Restore without asking for focus, and put
      // it back even if the capture fails. Leave an already shown window alone.
      const { windowId, bounds } = await withinCapture(() =>
        pipe.send<{
          windowId: number;
          bounds: { windowState: string };
        }>("Browser.getWindowForTarget", { targetId }),
      );
      if (bounds.windowState !== "minimized") return withinCapture(() => commands.capture(options));
      const setWindow = (windowState: string) =>
        withinCapture(async (signal) => {
          await pipe.send("Browser.setWindowBounds", { windowId, bounds: { windowState } });
          // The window manager applies the change after CDP acknowledges it.
          // Wait for the actual state, otherwise the minimize can arrive while
          // the earlier restore is still in flight and be ignored.
          while (!signal.aborted) {
            const { bounds } = await pipe.send<{ bounds: { windowState: string } }>(
              "Browser.getWindowBounds",
              { windowId },
            );
            if (bounds.windowState === windowState) return;
            await delay(25, undefined, { signal });
          }
        });
      try {
        await setWindow("normal");
        return await withinCapture(() => commands.capture(options));
      } finally {
        await setWindow("minimized");
      }
    },
    // Chrome drops a pointer event that reaches a new document before its
    // first frame, so pointer input waits for the page to draw.
    click: async (point) => {
      await drawn();
      await commands.click(point);
    },
    hover: async (point) => {
      await drawn();
      await commands.hover(point);
    },
    drag: async (source, destination) => {
      await drawn();
      return commands.drag(source, destination);
    },
    watch: (onFrame) => {
      state.watcher = onFrame;
      screencast(send, state);
      return () => {
        if (state.watcher !== onFrame) return;
        state.watcher = undefined;
        if (!closed) void send("Page.stopScreencast").catch(() => undefined);
      };
    },
    resize: async (next) => {
      if (closed) return;
      if (next.width === state.size.width && next.height === state.size.height) return;
      // Chrome's own bars take part of its window, so the page is sized, never the window.
      state.size = { width: next.width, height: next.height };
      await layOut(send, state);
      watchAgain();
    },
    revokeAsks: () => input.grants.revoke(),
    showWindow: input.showWindow,
    close: () => {
      if (closed) return;
      closed = true;
      state.watcher = undefined;
      endAsks(state);
      stopped();
      input.close();
    },
  };

  return {
    page,
    message,
    adopt: (worker) => {
      void hold(worker).catch(() => undefined);
    },
    info: (next) => {
      if (next.title !== undefined) title = next.title;
      // The address comes from the page's own navigation; Chrome's target
      // address fills it only before the first one.
      if (next.url !== undefined && !url) url = next.url;
    },
    gone,
    closedItself,
    hasFrame: (frameId) => frames.has(frameId),
    prepared,
    run: async () => {
      await send("Runtime.runIfWaitingForDebugger");
    },
    evaluate: async (expression) => {
      const answer = await send<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      const failed = answer.exceptionDetails;
      if (failed) throw new Error(failed.exception?.description ?? failed.text ?? "script failed");
      return answer.result?.value;
    },
  };
}
