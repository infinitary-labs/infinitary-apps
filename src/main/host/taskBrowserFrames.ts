import type { BrowserNode } from "@core/browser/outline";
import type { HostBrowserBox } from "@core/host";

/**
 * A task page's frames (docs/task-browser.md, "Frames"): the browser runs
 * a frame from another site in a process of its own, which the page's
 * protocol reaches only as a target of its own. Each one is attached as
 * it starts, paused until its page's guards are in it, and read and used
 * through its own session; a frame from the page's own site shares the
 * page's session and is read there by its frame id.
 *
 * The core names an element by one number (`BrowserNode.target`): the
 * page's own elements keep the browser's number, and a frame target's
 * carry that frame's place above `FRAME_SPAN`, so a number names its
 * frame as well as its element and is never used in another frame.
 * Clicks and typing still go to the page's own session, which routes
 * them to the frame under the point or holding the focus; only a box is
 * moved by where its frames sit on the page.
 */

/** The protocol, sent to the page's own session or to one of its frames'. */
export type SessionSend = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<T>;

/** Above every element number a browser gives, so each frame target has a span of its own. */
const FRAME_SPAN = 2 ** 31;

/** A frame running as a target of its own, attached through its parent's session. */
type FrameTarget = {
  sessionId: string;
  frameId: string;
  /** The session it was attached through; none for the page's own. */
  parent: string | undefined;
  /** Its place, which its elements' numbers carry. */
  place: number;
};

type RawAxValue = { value?: unknown };
export type RawAxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: RawAxValue;
  name?: RawAxValue;
  value?: RawAxValue;
  properties?: { name: string; value?: RawAxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

export function nodeOf(raw: RawAxNode): BrowserNode {
  const properties: Record<string, string | number | boolean> = {};
  for (const property of raw.properties ?? []) {
    const value = property.value?.value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      properties[property.name] = value;
    }
  }
  const value = raw.value?.value;
  return {
    id: raw.nodeId,
    role: typeof raw.role?.value === "string" ? raw.role.value : "",
    name: typeof raw.name?.value === "string" ? raw.name.value : "",
    ...(value === undefined || value === null ? {} : { value: String(value) }),
    ignored: raw.ignored === true,
    childIds: raw.childIds ?? [],
    ...(raw.backendDOMNodeId !== undefined ? { target: raw.backendDOMNodeId } : {}),
    properties,
  };
}

type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };

/** Where an element is: the session that reaches it, its own number there, and its frames from the page down. */
export type ElementPlace = { sessionId: string | undefined; node: number; chain: FrameTarget[] };

/** Give one document's nodes their own ids, so two documents' nodes never share one. */
function renamed(nodes: BrowserNode[], prefix: string): BrowserNode[] {
  if (!prefix) return nodes;
  return nodes.map((node) => ({
    ...node,
    id: `${prefix}${node.id}`,
    childIds: node.childIds.map((id) => `${prefix}${id}`),
  }));
}

function rootOf(nodes: readonly BrowserNode[]): BrowserNode | undefined {
  const children = new Set(nodes.flatMap((node) => node.childIds));
  return nodes.find((node) => !children.has(node.id));
}

function graft(nodes: BrowserNode[], owner: number, url: string, document: BrowserNode[]): boolean {
  const frame = nodes.find(
    (node) =>
      node.target === owner && (node.role === "Iframe" || node.role === "IframePresentational"),
  );
  const root = rootOf(document);
  if (!frame || !root) return false;
  frame.childIds = [...frame.childIds, root.id];
  frame.frameUrl = url;
  nodes.push(...document);
  return true;
}

export class PageFrames {
  private readonly bySession = new Map<string, FrameTarget>();
  private readonly byPlace = new Map<number, FrameTarget>();
  private next = 1;

  constructor(
    private readonly send: SessionSend,
    /** Put the page's guards into a frame that just started, before its own script runs. */
    private readonly prepare: (sessionId: string) => Promise<void>,
    /**
     * Whether a frame that could not be prepared stays held: an engine whose
     * preparation is what holds a frame's own frames and workers keeps it
     * from running, so nothing it starts skips the core.
     */
    private readonly holdUnprepared = false,
  ) {}

  /**
   * A protocol event: a frame target attached or went away. A target that
   * is not a frame is let go at once; a frame runs once it is prepared, and
   * unless `holdUnprepared`, whether or not that worked, so a page never
   * waits on it.
   */
  async onEvent(
    method: string,
    params: Record<string, unknown>,
    from: string | undefined,
  ): Promise<void> {
    if (method === "Target.attachedToTarget") {
      const sessionId = String(params.sessionId ?? "");
      const info = params.targetInfo as { type?: string; targetId?: string } | undefined;
      if (!sessionId) return;
      if (info?.type !== "iframe" || !info.targetId) {
        await this.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
        await this.send("Target.detachFromTarget", { sessionId }, from).catch(() => undefined);
        return;
      }
      const frame: FrameTarget = {
        sessionId,
        frameId: info.targetId,
        parent: from,
        place: this.next,
      };
      this.next += 1;
      this.bySession.set(sessionId, frame);
      this.byPlace.set(frame.place, frame);
      try {
        await this.prepare(sessionId);
      } catch {
        // A frame that went away while it was prepared has nothing left to run.
        if (this.holdUnprepared) return;
      }
      await this.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const gone = String(params.sessionId ?? "");
      for (const frame of [...this.bySession.values()]) {
        if (frame.sessionId === gone || this.chainOf(frame).some((up) => up.sessionId === gone)) {
          this.bySession.delete(frame.sessionId);
          this.byPlace.delete(frame.place);
        }
      }
    }
  }

  /** The number the core holds for an element of a session, from the browser's own. */
  targetOf(node: number, sessionId: string | undefined): number {
    const frame = sessionId ? this.bySession.get(sessionId) : undefined;
    return frame ? frame.place * FRAME_SPAN + node : node;
  }

  /** Where the element a core number names is; a frame that went away is nowhere. */
  placeOf(target: number): ElementPlace | undefined {
    const place = Math.floor(target / FRAME_SPAN);
    const node = target % FRAME_SPAN;
    if (place === 0) return { sessionId: undefined, node, chain: [] };
    const frame = this.byPlace.get(place);
    if (!frame) return undefined;
    return { sessionId: frame.sessionId, node, chain: [...this.chainOf(frame), frame] };
  }

  private chainOf(frame: FrameTarget): FrameTarget[] {
    const chain: FrameTarget[] = [];
    let parent = frame.parent ? this.bySession.get(frame.parent) : undefined;
    while (parent) {
      chain.unshift(parent);
      parent = parent.parent ? this.bySession.get(parent.parent) : undefined;
    }
    return chain;
  }

  /**
   * The whole page's accessibility tree: the page's own document, each
   * frame's under its frame's node. `marked` adds what a snapshot of a
   * session reads (`reading.ts`), with the browser's own numbers.
   */
  async nodes(
    marked: (nodes: BrowserNode[], sessionId: string | undefined) => Promise<BrowserNode[]>,
  ): Promise<BrowserNode[]> {
    return this.session(undefined, marked);
  }

  /** One session's documents, and the frame targets attached through it, beneath them. */
  private async session(
    sessionId: string | undefined,
    marked: (nodes: BrowserNode[], sessionId: string | undefined) => Promise<BrowserNode[]>,
  ): Promise<BrowserNode[]> {
    const tree = await this.send<{ nodes?: RawAxNode[] }>(
      "Accessibility.getFullAXTree",
      {},
      sessionId,
    );
    // Each document's node ids are its own, so they take a prefix naming it.
    const tag = sessionId ? `f${this.bySession.get(sessionId)?.place ?? "x"}` : "p";
    let documents = 0;
    const prefix = (): string => {
      documents += 1;
      return `${tag}d${documents}:`;
    };
    let nodes = (tree.nodes ?? []).map(nodeOf);
    if (sessionId) nodes = renamed(nodes, prefix());
    // The frames from the page's own site, which share its session.
    const own = await this.send<{ frameTree?: FrameTree }>("Page.getFrameTree", {}, sessionId)
      .then((answer) => answer.frameTree?.childFrames ?? [])
      .catch(() => [] as FrameTree[]);
    const pending = [...own];
    while (pending.length > 0) {
      const child = pending.shift() as FrameTree;
      pending.push(...(child.childFrames ?? []));
      try {
        const sub = await this.send<{ nodes?: RawAxNode[] }>(
          "Accessibility.getFullAXTree",
          { frameId: child.frame.id },
          sessionId,
        );
        const owner = await this.send<{ backendNodeId?: number }>(
          "DOM.getFrameOwner",
          { frameId: child.frame.id },
          sessionId,
        );
        if (owner.backendNodeId === undefined) continue;
        graft(
          nodes,
          owner.backendNodeId,
          child.frame.url,
          renamed((sub.nodes ?? []).map(nodeOf), prefix()),
        );
      } catch {
        // A frame that went away mid-read is not read.
      }
    }
    nodes = await marked(nodes, sessionId);
    // Each element's number names its frame too, so a ref never reaches another frame's.
    nodes = nodes.map((node) =>
      node.target === undefined ? node : { ...node, target: this.targetOf(node.target, sessionId) },
    );
    // The frames from other sites attached through this session.
    for (const frame of [...this.bySession.values()].filter((f) => f.parent === sessionId)) {
      try {
        const owner = await this.send<{ backendNodeId?: number }>(
          "DOM.getFrameOwner",
          { frameId: frame.frameId },
          sessionId,
        );
        if (owner.backendNodeId === undefined) continue;
        const url = await this.send<{ frameTree?: FrameTree }>(
          "Page.getFrameTree",
          {},
          frame.sessionId,
        ).then((answer) => answer.frameTree?.frame.url ?? "");
        const document = await this.session(frame.sessionId, marked);
        graft(nodes, this.targetOf(owner.backendNodeId, sessionId), url, document);
      } catch {
        // A frame that went away mid-read is not read.
      }
    }
    return nodes;
  }

  /**
   * Where a frame's own viewport sits on the page, and the part of the page
   * it shows: its owner element's content box, in each frame above it in
   * turn. With `scroll`, each owner is scrolled into view first.
   */
  async offset(
    chain: readonly FrameTarget[],
    scroll: boolean,
  ): Promise<{ x: number; y: number; clip: HostBrowserBox } | null> {
    let x = 0;
    let y = 0;
    let clip: HostBrowserBox | undefined;
    for (const frame of chain) {
      const owner = await this.send<{ backendNodeId?: number }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        frame.parent,
      );
      if (owner.backendNodeId === undefined) return null;
      if (scroll) {
        await this.send(
          "DOM.scrollIntoViewIfNeeded",
          { backendNodeId: owner.backendNodeId },
          frame.parent,
        );
      }
      const { model } = await this.send<{ model?: { content?: number[] } }>(
        "DOM.getBoxModel",
        { backendNodeId: owner.backendNodeId },
        frame.parent,
      );
      const content = model?.content;
      if (!content || content.length < 8) return null;
      const left = x + Math.min(content[0] ?? 0, content[6] ?? 0);
      const top = y + Math.min(content[1] ?? 0, content[3] ?? 0);
      const right = x + Math.max(content[2] ?? 0, content[4] ?? 0);
      const bottom = y + Math.max(content[5] ?? 0, content[7] ?? 0);
      const box = { x: left, y: top, width: right - left, height: bottom - top };
      clip = clip ? intersect(clip, box) : box;
      x = left;
      y = top;
    }
    return clip ? { x, y, clip } : null;
  }
}

function intersect(a: HostBrowserBox, b: HostBrowserBox): HostBrowserBox {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
