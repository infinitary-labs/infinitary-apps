import type { FrameEntryRef, HostMessage } from "@shared/plugins/bridge";
import { FRAME_ALLOW, FRAME_SANDBOX } from "@shared/plugins/containment";
import type {
  FrameTemplate,
  FrameTheme,
  FrameMount as Mount,
  PanelFrameConfig,
  PanelModule,
} from "@shared/plugins/frameDocument";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design";
import { hasShellPainted } from "../../design/reveals";
import { appReadExecutor } from "../reads/appExecutor";
import { FrameController, type FrameMountSpec } from "./frameController";
import { trackFrame } from "./frameFocus";
import { frameStylesheet, panelStylesheet } from "./frameStylesheet";

/**
 * A template mounted in the frame vehicle (docs/ui-plugins.md, phase 1):
 * the host serves the document over its own scheme, the iframe loads it
 * sandboxed, and this component owns the mount's lifetime and its
 * controller. The template is instantiated once; everything that changes
 * afterwards - data, theme - is pushed over the bridge, never re-rendered
 * into the document.
 *
 * The same component mounts a PANEL in the frame realm (one plugin vehicle,
 * Phase A item 4): given `panel` instead of `template`, the host serves a
 * document that boots the lib's runtime and draws that panel module - the
 * app's own Tasks or Activity, or a panel the captain added - with the
 * panel stylesheet rather than the card-body one. Everything after the
 * mount is the same vehicle: one controller, one bridge, the same checks.
 *
 * `layout: "fill"` sizes the frame to its container (a settings section);
 * `layout: "auto"` follows the document's own height as the bridge reports
 * it (a card body).
 */

export const AUTO_MIN_HEIGHT = 48;

/** What a panel mount draws: its module, and the runtime's config for `PanelProps`. */
export type FramePanelSource = { module: PanelModule; config: PanelFrameConfig };

/** A mount's document: a template, or a panel in the frame realm. */
type MountSource =
  | { template: FrameTemplate; panel?: undefined }
  | { panel: FramePanelSource; template?: undefined };

/** Shown when an armed watchdog tore a wedged panel down (the card body's line, for a panel). */
export const PANEL_UNRESPONSIVE_LINE = "This panel stopped responding.";

/**
 * A hidden page may not answer a ping. The watchdog does not count that as
 * a wedge: the window is hidden (the screen is off), or this frame sits in
 * a panel that is collapsed or off its rail. A showing card is watched.
 */
export function frameWatchPaused(frame: HTMLIFrameElement | null): boolean {
  if (document.hidden) return true;
  const panel = frame?.closest("[data-side-panel]");
  if (!panel) return false;
  return panel.hasAttribute("hidden") || panel.hasAttribute("data-side-panel-collapsed");
}

export type FrameMountProps = MountSource & {
  title: string;
  spec: FrameMountSpec;
  theme: FrameTheme;
  layout: "fill" | "auto";
  /** Bounds for `auto`: a card body never shrinks under AUTO_MIN_HEIGHT; a strip may. */
  minAutoHeight?: number;
  maxAutoHeight?: number;
  /** Allows a measuring parent to reveal the mount failure instead of waiting for a resize. */
  onMountError?: () => void;
  /**
   * Called once the document reports its initialized positive drawing
   * after host appearance, DOM and fonts are ready. Never on provisional height. The host shows controls that act on the frame's
   * contents only from then on (Rail.tsx).
   */
  onDrawn?: () => void;
  /** Owner captures boot snapshots before asynchronous content arrives. */
  reveal?: boolean;
};

/** Attaches a controller to an iframe: messages in, posts out. */
export function useFrameController(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  spec: FrameMountSpec,
  theme: FrameTheme,
  /**
   * Names the document the iframe is loading (a mount URL). Each new key
   * tells a watchdog-armed controller to expect a document's birth.
   */
  documentKey?: string,
): React.RefObject<FrameController | null> {
  const controllerRef = useRef<FrameController | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  // The controller lives as long as the iframe element. The theme it starts
  // with is the one at attach time; later themes are pushed by the effect
  // below, and the spec is read through a ref so a re-render never
  // re-attaches the listener.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is pushed separately; specRef is a ref
  useLayoutEffect(() => {
    const port = {
      post: (message: HostMessage) => {
        frameRef.current?.contentWindow?.postMessage(message, "*");
      },
    };
    const controller = new FrameController(
      {
        ...specRef.current,
        onAction: (id, value) =>
          specRef.current.onAction(id, value, frameRef.current?.getBoundingClientRect()),
        onResize: (height) => specRef.current.onResize?.(height),
        onDrawn: (height, width, held) => specRef.current.onDrawn?.(height, width, held),
        onBorn: () => specRef.current.onBorn?.(),
        onInteraction: () => specRef.current.onInteraction?.(),
        onLiveChange: () => specRef.current.onLiveChange?.(),
        onLink: (href) => specRef.current.onLink?.(href),
        onDraft: (text) => specRef.current.onDraft?.(text),
        // Only a mount that opens pictures makes them stops for the keyboard.
        ...(specRef.current.onImage
          ? {
              onImage: (index, pictures) =>
                specRef.current.onImage?.(index, pictures, frameRef.current),
            }
          : {}),
        ...(specRef.current.onDemo
          ? { onDemo: (demo) => specRef.current.onDemo?.(demo, frameRef.current) }
          : {}),
        onTask: (gesture, key, box) =>
          specRef.current.onTask?.(gesture, key, box, frameRef.current),
        onEntry: (id) => specRef.current.onEntry?.(id),
        ...(specRef.current.onEscape ? { onEscape: () => specRef.current.onEscape?.() } : {}),
        ...(specRef.current.onUnresponsive
          ? { onUnresponsive: () => specRef.current.onUnresponsive?.() }
          : {}),
        ...(specRef.current.form
          ? {
              form: {
                fill: () => specRef.current.form?.fill(),
                onAnswers: (answers) => specRef.current.form?.onAnswers(answers),
              },
            }
          : {}),
      },
      theme,
      {
        executor: appReadExecutor(),
        fetch: (call) => window.infinitary.plugins.fetch(call),
        store: window.infinitary.plugins.db,
        paused: () => frameWatchPaused(frameRef.current),
      },
      port,
    );
    controllerRef.current = controller;
    const listener = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      controller.receive(event.data);
    };
    window.addEventListener("message", listener);
    const untrack = trackFrame(frameRef, controller);
    return () => {
      untrack();
      window.removeEventListener("message", listener);
      controller.dispose();
      controllerRef.current = null;
    };
  }, [frameRef]);

  // Compared by content: the host hands a fresh list on every render.
  const revisionOffer = spec.revision?.offerId;
  const revisionStarts = spec.revision?.starts.join(",");
  useLayoutEffect(() => {
    controllerRef.current?.update({
      revision:
        revisionOffer && revisionStarts !== undefined
          ? {
              offerId: revisionOffer,
              starts: revisionStarts ? revisionStarts.split(",").map(Number) : [],
            }
          : undefined,
    });
  }, [revisionOffer, revisionStarts]);

  const readsKey = spec.reads.join(",");
  const viewsKey = (spec.grant?.sql ?? []).join(",");
  useEffect(() => {
    controllerRef.current?.update({
      reads: readsKey ? readsKey.split(",") : [],
      actions: spec.actions,
      grant: { sql: viewsKey ? viewsKey.split(",") : [] },
    });
  }, [readsKey, viewsKey, spec.actions]);

  useEffect(() => {
    controllerRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    controllerRef.current?.setState(spec.state);
  }, [spec.state]);

  useEffect(() => {
    controllerRef.current?.setWidth(spec.width);
  }, [spec.width]);

  const insetWidth = spec.inset?.width;
  const insetHeight = spec.inset?.height;
  useEffect(() => {
    controllerRef.current?.setInset(
      insetWidth === undefined || insetHeight === undefined
        ? undefined
        : { width: insetWidth, height: insetHeight },
    );
  }, [insetWidth, insetHeight]);

  useEffect(() => {
    controllerRef.current?.setMarkup(spec.markup);
  }, [spec.markup]);

  // Compared by content, like the reads: the card hands a fresh list on every render.
  const taskKeys = spec.taskKeys?.join(" ");
  useEffect(() => {
    controllerRef.current?.setTaskKeys(
      taskKeys === undefined ? undefined : taskKeys.split(" ").filter(Boolean),
    );
  }, [taskKeys]);

  const litKey = spec.litKey ?? null;
  useEffect(() => {
    controllerRef.current?.setLitKey(litKey);
  }, [litKey]);

  // Compared by content too: the references and the words each is read by.
  const entryRefs = spec.entryRefs ? JSON.stringify(spec.entryRefs) : undefined;
  useEffect(() => {
    controllerRef.current?.setEntryRefs(
      entryRefs === undefined ? undefined : (JSON.parse(entryRefs) as FrameEntryRef[]),
    );
  }, [entryRefs]);

  // A layout effect runs in the commit that points the iframe at the new
  // document, before any message task can deliver that document's `ready`,
  // so expecting a birth can never un-ready a document already born.
  useLayoutEffect(() => {
    if (documentKey !== undefined) controllerRef.current?.expectDocument();
  }, [documentKey]);

  return controllerRef;
}

export function FrameMount({
  title,
  template,
  panel,
  spec,
  theme,
  layout,
  minAutoHeight = AUTO_MIN_HEIGHT,
  maxAutoHeight = 280,
  onMountError,
  onDrawn,
  reveal: revealRequested,
}: FrameMountProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [reveal] = useState(() => revealRequested ?? hasShellPainted());
  const [mount, setMount] = useState<Mount | null>(null);
  const mountRef = useRef<Mount | null>(null);
  mountRef.current = mount;
  const [failure, setFailure] = useState<string | null>(null);
  const [height, setHeight] = useState(minAutoHeight);
  const [drawnDocument, setDrawnDocument] = useState<string | null>(null);
  // A watchdog-armed mount that stopped answering, and the retry that
  // remounts it: a fresh document, from the same source.
  const [wedged, setWedged] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onMountErrorRef = useRef(onMountError);
  onMountErrorRef.current = onMountError;
  // A panel source is compared by content: its owner hands a fresh object
  // on every render, and a remount rebuilds the whole document.
  const panelKey = panel ? JSON.stringify(panel) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content above
  const panelSource = useMemo(() => panel, [panelKey]);

  // One mount per template: the theme at mount time seeds the served
  // document, and every later theme is pushed over the bridge rather than
  // re-mounting (data never rebuilds the document - the point of the split).
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is pushed, not re-mounted; attempt is the retry
  useEffect(() => {
    let active = true;
    let mounted: Mount | null = null;
    setMount(null);
    setFailure(null);
    setWedged(false);
    const request = panelSource
      ? {
          kind: "panel" as const,
          title,
          theme,
          style: panelStylesheet(layout === "auto"),
          panel: panelSource.module,
          config: panelSource.config,
        }
      : { title, theme, style: frameStylesheet(), template: template as FrameTemplate };
    void window.infinitary.plugins
      .mountFrame(request)
      .then((result) => {
        if (!active) {
          void window.infinitary.plugins.unmountFrame(result.mountId).catch(() => {});
          return;
        }
        mounted = result;
        setMount(result);
      })
      .catch((caught: unknown) => {
        if (active) {
          setFailure(caught instanceof Error ? caught.message : String(caught));
          onMountErrorRef.current?.();
        }
      });
    return () => {
      active = false;
      if (mounted) void window.infinitary.plugins.unmountFrame(mounted.mountId).catch(() => {});
    };
  }, [title, template, panelSource, layout, attempt]);

  useFrameController(
    frameRef,
    {
      ...spec,
      onDrawn: (height, width, held) => {
        if (mount) setDrawnDocument(mount.mountId);
        spec.onDrawn?.(height, width, held);
      },
      onResize: (reported) => {
        // The document viewport is pixel-rounded. Auto-height panel documents
        // leave scrolling to their host; round up so the full fractional
        // content also fits that viewport without clipping its bottom edge.
        setHeight(Math.min(maxAutoHeight, Math.max(minAutoHeight, Math.ceil(reported))));
        spec.onResize?.(reported);
      },
      ...(spec.onUnresponsive
        ? {
            onUnresponsive: () => {
              // Removing the iframe detaches the wedged document; the browser
              // reaps its dedicated process, and the served document goes too.
              const wedgedMount = mountRef.current;
              if (wedgedMount) {
                void window.infinitary.plugins.unmountFrame(wedgedMount.mountId).catch(() => {});
              }
              setWedged(true);
              spec.onUnresponsive?.();
            },
          }
        : {}),
    },
    theme,
    mount?.url,
  );

  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;
  const drawn = mount !== null && drawnDocument === mount.mountId;
  useEffect(() => {
    if (drawn) onDrawnRef.current?.();
  }, [drawn]);

  if (wedged) {
    // The card's stopped state, for a panel (design skill Panel.prompt.md).
    return (
      <div
        data-frame-mount-unresponsive=""
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
        }}
      >
        <p style={{ margin: 0, color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
          {PANEL_UNRESPONSIVE_LINE}
        </p>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </div>
    );
  }

  if (failure) {
    return (
      <div
        data-frame-mount-failed=""
        style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)", padding: "var(--space-3)" }}
      >
        This panel could not be opened. {failure}
      </div>
    );
  }
  if (!mount)
    return (
      <div data-frame-mount-pending="" style={{ height: layout === "fill" ? "100%" : height }} />
    );
  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={FRAME_SANDBOX}
      allow={FRAME_ALLOW}
      src={mount.url}
      data-frame-mount={mount.mountId}
      data-frame-drawn={drawn ? "" : undefined}
      data-frame-reveal={reveal ? "" : undefined}
      style={{
        width: "100%",
        height: layout === "fill" ? "100%" : height,
        border: "none",
        display: "block",
        background: "transparent",
        opacity: reveal && !drawn ? 0 : undefined,
      }}
    />
  );
}
