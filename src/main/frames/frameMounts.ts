import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { frameCsp, panelFrameCsp } from "@shared/plugins/containment";
import {
  buildFrameDocument,
  buildPanelDocument,
  cardMountUrl,
  type DocumentMountRequest,
  type FrameMount,
  frameMountUrl,
  type PanelMountRequest,
  panelMountHost,
  panelMountUrl,
  scriptSafeJson,
} from "@shared/plugins/frameDocument";
import {
  builtinPanelFile,
  FRAME_LIB_BOOT,
  type FrameLibPins,
  frameLibUrl,
} from "@shared/plugins/frameLib";
import { panelCardViewModule } from "@shared/plugins/panelCards";
import { ElementType, parseDocument } from "htmlparser2";

/**
 * The live template mounts the shell serves (phase 1's frame vehicle,
 * docs/ui-plugins.md). The renderer hands over a template and gets back
 * the URL its iframe loads; the scheme handler (frameProtocol.ts) answers
 * that URL from here with the assembled document AND its CSP as a response
 * header, which is what lets the mount's own script run by hash while the
 * frame stays at `default-src 'none'`.
 *
 * Two kinds share the vehicle and the policy. A plugin template is served
 * at `app-frame://mount/<id>`; a card body carrying the agent's own inline
 * script (WI-16, docs/live-prototype-security.md) at `app-frame://card-<id>/`,
 * a host of its own so it gets a renderer process of its own. Each kind has
 * its own cap, so cards the agent emits can never crowd out the app's panels.
 *
 * The markup is served exactly as it arrived - there is no sanitizer since
 * the captain's 2026-09-15 decision. In a card mount, inline scripts stay
 * where their author put them, and this registry makes them run by hashing
 * every inline `<script>` that has no `src` into that mount's own CSP. In a
 * plugin template, scripts inside the markup remain unhashed and never run;
 * only its single `template.script` does. Everything else the document names
 * is refused by `default-src 'none'`: a `<script src>` left in the markup
 * never loads, and a script injected at run time has no hash.
 *
 * Plain Node, no Electron: the registry is the testable half, the protocol
 * handler the thin Electron half. Bounded on purpose - a mount cap refuses
 * loudly rather than letting a misbehaving renderer grow an unbounded map -
 * and ids are random, so one mount cannot guess another's document.
 */

/** Template documents this registry will hold at once before refusing the next. */
export const FRAME_MOUNT_CAP = 32;
/** Scripted card documents held at once; the stack shows one card at a time. */
export const CARD_MOUNT_CAP = 8;
/** Panel documents held at once: two rails of three, with room for a remount. */
export const PANEL_MOUNT_CAP = 16;
/** The most compiled files one added panel's graph may bring to its mount. */
export const PANEL_FILE_CAP = 256;
/** The most bytes one added panel's compiled graph may bring to its mount. */
export const PANEL_BYTES_CAP = 8 * 1024 * 1024;

export type ServedFrameDocument = {
  body: string;
  csp: string;
};

type Kind = "template" | "card" | "panel";

export class FrameMountCapError extends Error {
  constructor(cap: number, kind: Kind) {
    super(
      kind === "template"
        ? `the frame host already serves ${cap} mounts; unmount one first`
        : `the frame host already serves ${cap} ${kind} mounts; unmount one first`,
    );
    this.name = "FrameMountCapError";
  }
}

/** A panel mount the host could not assemble; the message says why. */
export class PanelMountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelMountError";
  }
}

export function scriptHash(script: string): string {
  return `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;
}

export function bytesHash(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

/**
 * Where the registry finds what a panel mount draws (the frame realm): the
 * lib's pins, and the directory holding an added panel's compiled graph -
 * asked of the core, which answers only for a panel it serves at exactly
 * that version, so a mount can never reach a graph the captain did not
 * agree to or one he has since removed.
 */
export type PanelSources = {
  libPins: FrameLibPins;
  installedPanelDir: (id: string, version: string) => string | null;
};

type HeldDocument = ServedFrameDocument & {
  kind: Kind;
  /** A panel mount's own modules, by path under its host, read and hashed at mount. */
  files?: ReadonlyMap<string, Uint8Array>;
};

const PANEL_FILE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Reads an added panel's compiled graph once, at mount: every `.mjs` under
 * its version directory, by forward-slashed relative path. What the mount
 * serves afterwards is exactly these bytes, hashed into the document's
 * import map - a file written to the cache later reaches no frame.
 */
async function readPanelGraph(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = async (relative: string[]): Promise<void> => {
    const entries = await readdir(join(dir, ...relative), { withFileTypes: true });
    for (const entry of entries) {
      if (!PANEL_FILE_SEGMENT.test(entry.name) || entry.name === "." || entry.name === "..") {
        continue;
      }
      if (entry.isDirectory()) {
        if (relative.length >= 8) continue;
        await walk([...relative, entry.name]);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const bytes = new Uint8Array(await readFile(join(dir, ...relative, entry.name)));
      total += bytes.byteLength;
      if (files.size + 1 > PANEL_FILE_CAP || total > PANEL_BYTES_CAP) {
        throw new PanelMountError("this panel's code is larger than a panel may be");
      }
      files.set([...relative, entry.name].join("/"), bytes);
    }
  };
  await walk([]);
  return files;
}

/**
 * The text of every inline `<script>` in a document's markup, in document
 * order. A script with `src` is skipped: it loads nothing under the frame
 * policy, so hashing its (usually empty) text would pin a source that can
 * never execute; an empty one is skipped for the same reason. After parsing,
 * line endings are normalized as the browser's HTML parser normalizes them,
 * so the CSP hash covers the script text the browser actually executes.
 */
export function inlineScripts(html: string): string[] {
  const found: string[] = [];
  const walk = (nodes: ReturnType<typeof parseDocument>["children"]): void => {
    for (const node of nodes) {
      if (node.type === ElementType.Script) {
        const text = node.children
          .map((child) => ("data" in child ? child.data : ""))
          .join("")
          .replace(/\r\n?/g, "\n");
        if (!("src" in node.attribs) && text.length > 0) found.push(text);
        continue;
      }
      if ("children" in node) walk(node.children);
    }
  };
  walk(parseDocument(html).children);
  return found;
}

export class FrameMountRegistry {
  private readonly documents = new Map<string, HeldDocument>();

  constructor(
    private readonly options: {
      cap?: number;
      cardCap?: number;
      panelCap?: number;
      newId?: () => string;
      /** What a panel mount draws; absent, every panel mount is refused. */
      panels?: PanelSources;
    } = {},
  ) {}

  get size(): number {
    return this.documents.size;
  }

  private capOf(kind: Kind): number {
    if (kind === "card") return this.options.cardCap ?? CARD_MOUNT_CAP;
    if (kind === "panel") return this.options.panelCap ?? PANEL_MOUNT_CAP;
    return this.options.cap ?? FRAME_MOUNT_CAP;
  }

  private admit(kind: Kind): void {
    const cap = this.capOf(kind);
    let held = 0;
    for (const document of this.documents.values()) if (document.kind === kind) held += 1;
    if (held >= cap) throw new FrameMountCapError(cap, kind);
  }

  /** A template or a card body; a panel mount reads files and is `mountPanel`. */
  mount(request: DocumentMountRequest): FrameMount {
    const kind: Kind = request.kind ?? "template";
    this.admit(kind);
    const html = request.template.html;
    // Every script this document may run: the ones a card's markup carries
    // in place (WI-16), or the template's single trailing script for a plugin
    // mount. Nothing else is pinned beside the bridge - the figure helper is
    // gone, and a scripted body draws its own SVG.
    let templateScript: string | undefined;
    let scripts: string[];
    if (request.kind === "card") {
      scripts = inlineScripts(html);
    } else {
      templateScript = request.template.script;
      scripts = templateScript ? [templateScript] : [];
    }
    // One source per distinct script: two identical scripts share a hash.
    const hashes = [...new Set(scripts.map(scriptHash))];
    const csp = frameCsp(hashes);
    const body = buildFrameDocument({
      csp,
      theme: request.theme,
      title: request.title,
      style: request.style,
      html,
      ...(templateScript ? { script: templateScript } : {}),
      // A card's page waits to run its scripts until the card is shown.
      ...(kind === "card" ? { held: true } : {}),
    });
    const mountId = (this.options.newId ?? randomUUID)();
    this.documents.set(mountId, { body, csp, kind });
    return { mountId, url: kind === "card" ? cardMountUrl(mountId) : frameMountUrl(mountId) };
  }

  /**
   * A panel drawn in the frame realm (one plugin vehicle, Phase A items 4
   * and 6), at a host of its own: `app-frame://panel-<id>/`. The document
   * is the lib's boot plus the runtime's config; its policy admits module
   * scripts from the lib and from this mount's host alone
   * (`panelFrameCsp`); and its import map pins every module either may
   * serve - the lib by the pins baked into this build, an added panel's
   * compiled files by the hashes of the bytes read here, which are the
   * only bytes the mount will ever serve.
   */
  async mountPanel(request: PanelMountRequest): Promise<FrameMount> {
    this.admit("panel");
    const sources = this.options.panels;
    if (!sources) throw new PanelMountError("this build draws no panels in frames");
    const boot = sources.libPins[FRAME_LIB_BOOT];
    if (!boot) throw new PanelMountError("this build's panel library is missing");
    const mountId = (this.options.newId ?? randomUUID)();
    const host = panelMountHost(mountId);
    let module: string;
    let files: Map<string, Uint8Array> | undefined;
    if (request.panel.source === "builtin") {
      const file = builtinPanelFile(request.panel.id, request.panel.view);
      if (!sources.libPins[file]) throw new PanelMountError(`this build has no "${file}"`);
      module = frameLibUrl(file);
    } else {
      const dir = sources.installedPanelDir(request.panel.id, request.panel.version);
      if (!dir) {
        throw new PanelMountError(
          `"${request.panel.id}" is not an added panel at version ${request.panel.version}`,
        );
      }
      files = await readPanelGraph(dir);
      // A card view is an entry of the same pinned graph (docs/ui-plugins.md,
      // "A panel's cards"): its own module, beside the panel's.
      const entry =
        request.panel.view === undefined ? "panel.mjs" : panelCardViewModule(request.panel.view);
      if (!files.has(entry)) throw new PanelMountError(`this panel's code has no entry: ${entry}`);
      module = `${panelMountUrl(mountId)}${entry}`;
    }
    // The cap again: the read above awaited, and a sibling may have landed.
    this.admit("panel");
    const integrity: Record<string, string> = {};
    for (const [file, pin] of Object.entries(sources.libPins)) integrity[frameLibUrl(file)] = pin;
    for (const [path, bytes] of files ?? []) {
      integrity[`${panelMountUrl(mountId)}${path}`] = bytesHash(bytes);
    }
    const importMap = scriptSafeJson({ imports: {}, integrity });
    const csp = panelFrameCsp([scriptHash(importMap)], host);
    const body = buildPanelDocument({
      csp,
      theme: request.theme,
      title: request.title,
      style: request.style,
      importMap,
      config: { ...request.config, module },
      bootIntegrity: boot,
    });
    this.documents.set(mountId, { body, csp, kind: "panel", ...(files ? { files } : {}) });
    return { mountId, url: panelMountUrl(mountId) };
  }

  unmount(mountId: string): boolean {
    return this.documents.delete(mountId);
  }

  /** A panel mount's document, served at its own `panel-<id>` host. */
  panelDocument(mountId: string): ServedFrameDocument | undefined {
    return this.served(mountId, "panel");
  }

  /** One of a panel mount's own modules, exactly as read at mount; nothing else. */
  panelFile(mountId: string, path: string): Uint8Array | undefined {
    const document = this.documents.get(mountId);
    return document?.kind === "panel" ? document.files?.get(path) : undefined;
  }

  /** A plugin template's document, served under `mount/`. */
  document(mountId: string): ServedFrameDocument | undefined {
    return this.served(mountId, "template");
  }

  /** A scripted card body's document, served at its own `card-<id>` host. */
  cardDocument(mountId: string): ServedFrameDocument | undefined {
    return this.served(mountId, "card");
  }

  /** Every mount at once - the renderer that owned them is gone. */
  clear(): void {
    this.documents.clear();
  }

  private served(mountId: string, kind: Kind): ServedFrameDocument | undefined {
    const document = this.documents.get(mountId);
    return document?.kind === kind ? { body: document.body, csp: document.csp } : undefined;
  }
}
