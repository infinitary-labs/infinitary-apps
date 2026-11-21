import type { CenterCue, CrewedWait } from "@shared/dependencyVisual";
import { type DeviceView, deviceRunsWork } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import type { Slot } from "@shared/modelSlots";
import { HERE } from "../../../../shared/deviceNames";
import { Spring } from "../face";
import type { WarpFrame } from "../warp";
import { type Program, programShare } from "./constellation";
import {
  CrewOrbit,
  type CrewStatus,
  type CrewWait,
  type Cue,
  type DependencyLink,
  type LeaveMode,
  type OrbitFrame,
  type PacketDirection,
} from "./orbit";
import { outerPlaneRadius } from "./orbitalPlanes";

export const HOME_COMPUTER = "home";
export const COMPUTERS_PER_PAGE = 6;

/**
 * The multi-computer stage the captain chose on the FI3-1519 plan: every
 * other computer's crew form the home formation at a share of its size, in
 * two wings left and right of the home formation beyond its edge plus a
 * gap, stacked within a wing; the whole scene shrinks only when the window
 * is narrower than it (docs/crew-orbits.md, "Multiple work computers").
 */
export const CLUSTER_LAYOUT = {
  /** Clear air between the home formation's edge and a cluster's, px. */
  gapPx: 40,
  /** A remote cluster's orbits, as a share of home's. */
  sizeShare: 0.5,
  /** A cluster crewmate's glyph, px, before the depth cue... */
  crewGlyphPx: 23,
  /** ...and once the cluster holds more crew than `crowdedCrew`. */
  crowdedGlyphPx: 18,
  crowdedCrew: 12,
  /** Half a glyph beyond the outer orbit: where a formation's edge is, px. */
  glyphPx: 13,
  /** A cluster's name sits this far under its edge, px. */
  labelPx: 20,
  /** Room for that name between stacked clusters, on top of the gap, px. */
  stackPx: 22,
  /** Clear air the scene keeps from the window's sides, px... */
  sideMarginPx: 24,
  /** ...and from the top bar and the input, px. */
  endMarginPx: 44,
  /** The scene never shrinks below this share of its size. */
  minFit: 0.3,
} as const;

export type ComputerCluster = {
  id: string;
  name: string;
  reachable: boolean;
  /** The cluster's center, px from the Firstmate's center, screen axes. */
  x: number;
  y: number;
  labelY: number;
  /** The cluster's outer orbit as painted, px. */
  radius: number;
};
/** Where a cluster is headed, and its springs that carry it there. */
type Seat = { x: Spring; y: Spring; radius: number };
type LocalOrbit = {
  model: CrewOrbit;
  time: number;
  last: number;
  frozen?: OrbitFrame;
  frozenCenter?: { x: number; y: number };
  lastCenter?: { x: number; y: number };
  lastFrame?: OrbitFrame;
};

/** The original orbit always owns home. Remote computers add independent
 * adaptive orbits without changing home's geometry or lifecycle. */
export class ComputerOrbits extends CrewOrbit {
  private devices: readonly DeviceView[] = [];
  private placement = new Map<string, string | null>();
  private locals = new Map<string, LocalOrbit>();
  private seats = new Map<string, Seat>();
  private clock: number;
  private pageIndex = 0;
  private positions = new Map<string, ComputerCluster>();
  private homeName: string = HERE.This;
  private clusterCues: Cue[] = [];
  private owners = new Map<string, string>();
  private tiers = new Map<string, Slot | undefined>();
  private reviewEdges = new Map<string, string>();
  private waits: readonly CrewedWait[] = [];
  /** The board's programs, and the computers each is drawn on. */
  private programList: readonly Program[] = [];
  private programAt = new Map<string, readonly string[]>();
  constructor(now: number, random: () => number = Math.random) {
    super(now, undefined, random, "adaptive");
    this.clock = now;
  }
  get multiple(): boolean {
    return this.computers().length > 1 && this.present().every((id) => this.placement.has(id));
  }
  get page(): number {
    return this.pageIndex;
  }
  get pages(): number {
    return Math.max(1, Math.ceil((this.computers().length - 1) / (COMPUTERS_PER_PAGE - 1)));
  }
  setPage(page: number): void {
    const next = Math.max(0, Math.min(this.pages - 1, page));
    if (next === this.pageIndex) return;
    this.pageIndex = next;
    this.bump();
  }
  configure(devices: readonly DeviceView[], homeName: string = HERE.This): void {
    this.homeName = homeName;
    this.devices = devices;
    for (const id of this.present()) this.relocate(id);
    this.pageIndex = Math.min(this.pageIndex, this.pages - 1);
    this.bump();
  }
  setPlacement(id: string, deviceId: string | null): void {
    if (this.placement.get(id) === deviceId) return;
    const before = this.computerOf(id);
    this.placement.set(id, deviceId);
    const after = this.computerOf(id);
    if (before !== after && this.has(id)) this.relocate(id);
    this.routeDependencies();
    if (before !== after) this.routePrograms(this.clock);
    this.bump();
  }
  isHome(id: string): boolean {
    return this.computerOf(id) === HOME_COMPUTER;
  }
  override present(): string[] {
    return [
      ...super.present(),
      ...Array.from(this.locals.values()).flatMap((local) => local.model.present()),
    ];
  }
  override has(id: string): boolean {
    return super.has(id) || Array.from(this.locals.values()).some((local) => local.model.has(id));
  }
  override statusOf(id: string): CrewStatus | undefined {
    return this.isHome(id)
      ? super.statusOf(id)
      : this.locals.get(this.computerOf(id))?.model.statusOf(id);
  }
  /**
   * A crewmate's placement arrived after its spawn, or changed: it leaves
   * the orbit it was on at once - no departure, no snap of the others - and
   * takes its place on the right one, still as a spark if it was one.
   */
  private relocate(id: string): void {
    const after = this.computerOf(id);
    const before = this.owners.get(id);
    if (before === after) return;
    const source = before === HOME_COMPUTER ? this : this.locals.get(before ?? "")?.model;
    const status = before === HOME_COMPUTER ? super.statusOf(id) : source?.statusOf(id);
    const settled = source?.phaseOf(id) !== "spawning";
    if (before === HOME_COMPUTER) super.discard(id);
    else if (before) {
      const old = this.locals.get(before);
      old?.model.discard(id);
      if (old) {
        delete old.frozen;
        delete old.lastFrame;
      }
    }
    this.owners.set(id, after);
    if (after === HOME_COMPUTER)
      super.spawn(id, status ?? "idle", this.clock, settled, this.tiers.get(id));
    else {
      const next = this.local(after);
      delete next.frozen;
      delete next.lastFrame;
      next.model.spawn(id, status ?? "idle", next.time, settled, this.tiers.get(id));
    }
  }

  /** The computer a crewmate is placed on: home unless placed on another Mac. */
  computerOf(id: string): string {
    const placed = this.placement.get(id);
    if (!placed || this.devices.some((d) => d.id === placed && d.onThisMac)) return HOME_COMPUTER;
    return placed;
  }
  private computers(): Array<{ id: string; name: string; reachable: boolean }> {
    const list = this.devices
      .filter((d) => deviceRunsWork(d.kind) && !d.onThisMac)
      .slice()
      .sort((a, b) => a.pairedAt - b.pairedAt || a.id.localeCompare(b.id))
      .map((d) => ({ id: d.id, name: d.name, reachable: d.inReach === true }));
    // A removed computer's still-active last-known crew retain their identity.
    for (const id of this.present()) {
      const computer = this.computerOf(id);
      if (computer !== HOME_COMPUTER && !list.some((d) => d.id === computer))
        list.push({ id: computer, name: m.crewUnavailableComputer(), reachable: false });
    }
    return [{ id: HOME_COMPUTER, name: this.homeName, reachable: true }, ...list];
  }
  /** The other computers on this page, in pairing order. */
  private pagePeers(): Array<{ id: string; name: string; reachable: boolean }> {
    return this.computers().slice(1 + this.pageIndex * 5, 1 + (this.pageIndex + 1) * 5);
  }
  /**
   * Where each crewed computer on the page is headed: the wings. The first
   * sits right of the home formation, the second left, then they stack top
   * to bottom within a wing; a computer with no crew keeps no seat. Every
   * seat clears the home formation's edge by the gap, and a wing's seats
   * stand as far out as its widest cluster needs.
   */
  private targets(): Map<string, { x: number; y: number; radius: number }> {
    const crewed = new Map<string, number>();
    for (const id of this.present()) {
      const computer = this.computerOf(id);
      crewed.set(computer, (crewed.get(computer) ?? 0) + 1);
    }
    const homeEdge = outerPlaneRadius(crewed.get(HOME_COMPUTER) ?? 0) + CLUSTER_LAYOUT.glyphPx;
    const radiusOf = (id: string) =>
      outerPlaneRadius(crewed.get(id) ?? 0) * CLUSTER_LAYOUT.sizeShare;
    const seated = this.pagePeers().filter((peer) => (crewed.get(peer.id) ?? 0) > 0);
    const targets = new Map<string, { x: number; y: number; radius: number }>();
    const wing = (list: typeof seated, side: 1 | -1) => {
      if (list.length === 0) return;
      const widest = Math.max(...list.map((peer) => radiusOf(peer.id)));
      const step = 2 * widest + CLUSTER_LAYOUT.gapPx + CLUSTER_LAYOUT.stackPx;
      const x = side * (homeEdge + CLUSTER_LAYOUT.gapPx + widest);
      list.forEach((peer, j) => {
        targets.set(peer.id, {
          x,
          y: (j - (list.length - 1) / 2) * step,
          radius: radiusOf(peer.id),
        });
      });
    };
    wing(
      seated.filter((_, i) => i % 2 === 0),
      1,
    );
    wing(
      seated.filter((_, i) => i % 2 === 1),
      -1,
    );
    return targets;
  }
  /**
   * The seats as they stand: each glides to its target on a spring when the
   * formations around it grow or shrink, and a new one appears in place.
   */
  private settleSeats(dt: number, settled: boolean): void {
    const targets = this.targets();
    for (const id of this.seats.keys()) if (!targets.has(id)) this.seats.delete(id);
    for (const [id, target] of targets) {
      let seat = this.seats.get(id);
      if (!seat) {
        seat = {
          x: new Spring(target.x, 0.7, 1),
          y: new Spring(target.y, 0.7, 1),
          radius: target.radius,
        };
        this.seats.set(id, seat);
      }
      seat.radius = target.radius;
      if (settled || dt === 0) {
        if (settled) {
          seat.x.x = target.x;
          seat.y.x = target.y;
          seat.x.v = 0;
          seat.y.v = 0;
        }
        continue;
      }
      seat.x.step(target.x, dt);
      seat.y.step(target.y, dt);
    }
  }
  clusters(): ComputerCluster[] {
    if (!this.multiple) return [];
    if (this.seats.size === 0) this.settleSeats(0, false);
    const [home, ...peers] = this.computers();
    const out: ComputerCluster[] = [];
    if (home) {
      const radius = outerPlaneRadius(super.present().length);
      out.push({ ...home, x: 0, y: 0, labelY: 224, radius });
    }
    for (const peer of peers) {
      const seat = this.seats.get(peer.id);
      if (!seat) continue;
      const x = seat.x.x;
      const y = seat.y.x;
      out.push({
        ...peer,
        x,
        y,
        labelY: y + seat.radius + CLUSTER_LAYOUT.labelPx,
        radius: seat.radius,
      });
    }
    return out;
  }
  /** The clusters that show their name: only those with crew on this page,
   * and none while home's are the only crew. */
  labeled(): ComputerCluster[] {
    const crewed = new Set(this.present().map((id) => this.computerOf(id)));
    const named = this.clusters().filter((cluster) => crewed.has(cluster.id));
    return named.some((cluster) => cluster.id !== HOME_COMPUTER) ? named : [];
  }
  /**
   * How far the scene reaches from the Firstmate's center, px, with the
   * clear air it keeps: the view fits the whole scene to the window from it.
   */
  private sceneNeed(clusters: readonly ComputerCluster[]): {
    halfWidth: number;
    halfHeight: number;
  } {
    let halfWidth = 1;
    let halfHeight = 1;
    for (const cluster of clusters) {
      if (cluster.id === HOME_COMPUTER) continue;
      halfWidth = Math.max(
        halfWidth,
        Math.abs(cluster.x) + cluster.radius + CLUSTER_LAYOUT.sideMarginPx,
      );
      halfHeight = Math.max(
        halfHeight,
        Math.abs(cluster.y) + cluster.radius + CLUSTER_LAYOUT.endMarginPx,
      );
    }
    return { halfWidth, halfHeight };
  }
  private localTime(id: string): number {
    return this.locals.get(id)?.time ?? this.clock;
  }
  private local(id: string): LocalOrbit {
    const found = this.locals.get(id);
    if (found) return found;
    const local: LocalOrbit = {
      time: this.clock,
      last: this.clock,
      model: new CrewOrbit(
        this.clock,
        undefined,
        () => 0.5,
        "adaptive",
        // The home formation at a share of its size, around the cluster's
        // seat. Sparks, falls home and packets fly in screen space to the
        // ONE Firstmate (orbit.ts), never to an invisible remote character.
        (point) => {
          const cluster = this.positions.get(id);
          return {
            x: point.x * CLUSTER_LAYOUT.sizeShare + (cluster?.x ?? 0),
            y: point.y * CLUSTER_LAYOUT.sizeShare + (cluster?.y ?? 0),
            depth: point.depth,
          };
        },
      ),
    };
    local.model.subscribe(() => this.bump());
    this.locals.set(id, local);
    for (const [reviewer, builder] of this.reviewEdges) local.model.setReview(reviewer, builder);
    local.model.setCaptainWaits(this.captainIds);
    local.model.setPinned(this.pinnedIds);
    this.routeDependencies();
    return local;
  }
  private pendingDependencies: CenterCue[] = [];
  /** Split the board's waits onto the orbit that actually holds each crewmate. */
  override setDependencies(cues: readonly CenterCue[]): void {
    this.pendingDependencies = [...cues];
    this.routeDependencies();
  }
  /** Every wait between two crewmates; the ones that cross computers draw an arrow across the stage. */
  setWaits(waits: readonly CrewedWait[]): void {
    const key = (list: readonly CrewedWait[]) =>
      list.map((wait) => `${wait.waiterId}>${wait.blockerId}`).join();
    if (key(waits) === key(this.waits)) return;
    this.waits = [...waits];
    this.bump();
  }
  /**
   * The arrows between crewmates on different computers (captain, INF-556):
   * a wait in the quiet gray and a review in the working ember, with the
   * same reach. Nobody moves for them: each computer's orbit circles only
   * its own crew. A builder's merge hold on its own reviewer draws nothing,
   * as on one computer, and an end not on the stage draws nothing.
   */
  private acrossLinks(crew: OrbitFrame["crew"]): DependencyLink[] {
    const shown = new Set(crew.filter((c) => c.phase === "orbiting").map((c) => c.id));
    const across = (from: string, to: string) =>
      shown.has(from) && shown.has(to) && this.computerOf(from) !== this.computerOf(to);
    const links: DependencyLink[] = [];
    for (const [reviewer, builder] of this.reviewEdges)
      if (across(reviewer, builder))
        links.push({ fromId: reviewer, toId: builder, kind: "review" });
    for (const { waiterId, blockerId } of this.waits) {
      if (this.reviewEdges.get(blockerId) === waiterId) continue;
      if (this.reviewEdges.get(waiterId) === blockerId) continue;
      if (across(waiterId, blockerId))
        links.push({ fromId: waiterId, toId: blockerId, kind: "wait" });
    }
    return links;
  }
  /**
   * A program draws a copy of its ring in the group of each computer that
   * runs its parts, each copy with the crewmates running there (INF-1037,
   * the captain's choice A), so every crewmate stays where its work runs.
   * With none running, between stages, its rings stay where they were drawn,
   * or one at home.
   */
  override setPrograms(list: readonly Program[], now: number): void {
    this.programList = [...list];
    this.routePrograms(now);
  }
  private routePrograms(now: number): void {
    const byComputer = new Map<string, Program[]>();
    const placed = new Map<string, readonly string[]>();
    for (const program of this.programList) {
      const running = program.parts.filter((part) => part.state === "live");
      const live = [...new Set(running.map((part) => this.computerOf(part.id)))];
      const at = live.length > 0 ? live : (this.programAt.get(program.id) ?? [HOME_COMPUTER]);
      placed.set(program.id, at);
      for (const computer of at) {
        // Each copy holds only the parts running on its own computer.
        const parts = program.parts.filter(
          (part) => part.state !== "live" || this.computerOf(part.id) === computer,
        );
        const list = byComputer.get(computer) ?? [];
        // Each copy's gem counts the whole program's parts.
        list.push({ ...program, parts, share: programShare(program) });
        byComputer.set(computer, list);
      }
    }
    this.programAt = placed;
    super.setPrograms(byComputer.get(HOME_COMPUTER) ?? [], now);
    for (const id of byComputer.keys()) if (id !== HOME_COMPUTER) this.local(id);
    for (const [id, local] of this.locals)
      local.model.setPrograms(byComputer.get(id) ?? [], local.time);
  }
  private routeDependencies(): void {
    const byComputer = new Map<string, CenterCue[]>();
    for (const cue of this.pendingDependencies) {
      const computer = this.computerOf(cue.waiterId);
      const list = byComputer.get(computer) ?? [];
      list.push(cue);
      byComputer.set(computer, list);
    }
    super.setDependencies(byComputer.get(HOME_COMPUTER) ?? []);
    for (const [id, local] of this.locals) local.model.setDependencies(byComputer.get(id) ?? []);
  }
  override spawn(
    id: string,
    status: CrewStatus,
    now: number,
    settled = false,
    tier?: Slot,
    wait: CrewWait = null,
  ): void {
    // One leaving counts as new: it arrives anew (CrewOrbit.spawn).
    const existed = this.present().includes(id);
    const computer = this.computerOf(id);
    this.owners.set(id, computer);
    if (!existed) this.tiers.set(id, tier);
    if (computer === HOME_COMPUTER) {
      super.spawn(id, status, now, settled, tier, wait);
      return;
    }
    const local = this.local(computer);
    if (!existed) {
      delete local.frozen;
      delete local.lastFrame;
    }
    local.model.spawn(id, status, local.time, settled, tier, wait);
  }
  override setStatus(id: string, status: CrewStatus): void {
    if (this.isHome(id)) super.setStatus(id, status);
    else this.local(this.computerOf(id)).model.setStatus(id, status);
  }
  private captainIds: string[] = [];
  /** Every orbit hears the whole set; each paints only the crew it holds. */
  override setCaptainWaits(ids: Iterable<string>): void {
    this.captainIds = [...ids];
    super.setCaptainWaits(this.captainIds);
    for (const local of this.locals.values()) local.model.setCaptainWaits(this.captainIds);
  }
  private pinnedIds: string[] = [];
  /** Every orbit hears the whole list; each hangs only the crew it holds, as its own constellation. */
  override setPinned(ids: Iterable<string>): void {
    this.pinnedIds = [...ids];
    super.setPinned(this.pinnedIds);
    for (const local of this.locals.values()) local.model.setPinned(this.pinnedIds);
  }
  override setWait(id: string, wait: CrewWait): void {
    if (this.isHome(id)) super.setWait(id, wait);
    else this.local(this.computerOf(id)).model.setWait(id, wait);
  }
  override setTier(id: string, tier: Slot | undefined): void {
    this.tiers.set(id, tier);
    if (this.isHome(id)) super.setTier(id, tier);
    else this.local(this.computerOf(id)).model.setTier(id, tier);
  }
  override setReview(reviewer: string, builder: string | null): void {
    super.setReview(reviewer, builder);
    if (builder) this.reviewEdges.set(reviewer, builder);
    else this.reviewEdges.delete(reviewer);
    for (const local of this.locals.values()) local.model.setReview(reviewer, builder);
  }
  override signal(id: string, direction: PacketDirection, now: number): void {
    if (this.isHome(id)) {
      super.signal(id, direction, now);
      return;
    }
    const computer = this.computerOf(id);
    this.local(computer).model.signal(id, direction, this.localTime(computer));
  }
  override nudge(id: string, now: number): void {
    if (this.isHome(id)) {
      super.nudge(id, now);
      return;
    }
    const computer = this.computerOf(id);
    this.local(computer).model.nudge(id, this.localTime(computer));
  }
  override flicker(id: string, strength: number, now: number): void {
    if (this.isHome(id)) {
      super.flicker(id, strength, now);
      return;
    }
    const computer = this.computerOf(id);
    this.local(computer).model.flicker(id, strength, this.localTime(computer));
  }
  override leave(id: string, mode: LeaveMode, now: number): void {
    if (this.isHome(id)) {
      super.leave(id, mode, now);
      return;
    }
    const computer = this.computerOf(id);
    const local = this.local(computer);
    delete local.frozen;
    delete local.lastFrame;
    local.model.leave(id, mode, this.localTime(computer));
  }
  override settleBootRoster(now: number): void {
    super.settleBootRoster(now);
    for (const local of this.locals.values()) local.model.settleBootRoster(local.time);
  }
  override takeCues(): Cue[] {
    const legacy = super.takeCues();
    if (!this.multiple) return legacy;
    const cues = [...legacy, ...this.clusterCues];
    this.clusterCues = [];
    return cues;
  }
  override update(
    now: number,
    settled = false,
    rush = 0,
    warp: WarpFrame | null = null,
  ): OrbitFrame {
    const dt = Math.min(Math.max(0, now - this.clock) / 1000, 0.05);
    this.clock = now;
    const legacy = super.update(now, settled, rush, warp);
    this.settleSeats(dt, settled);
    const clusters = this.clusters();
    this.positions = new Map(clusters.map((c) => [c.id, c]));
    const frames: OrbitFrame[] = [
      { ...legacy, crew: legacy.crew.map((c) => ({ ...c, computerId: HOME_COMPUTER })) },
    ];
    for (const computer of this.computers()) {
      if (computer.id === HOME_COMPUTER) continue;
      const local = this.local(computer.id);
      const count = local.model.present().length;
      const delta = Math.max(0, now - local.last);
      local.last = now;
      if (computer.reachable) {
        local.time += delta;
        delete local.frozen;
        delete local.frozenCenter;
      }
      if (!computer.reachable && !local.frozen) {
        local.frozen = local.lastFrame ?? local.model.update(local.time, true, 0);
        const center = this.positions.get(computer.id);
        local.frozenCenter = local.lastCenter ?? { x: center?.x ?? 0, y: center?.y ?? 0 };
      }
      // The black hole's rush and the warps stay at home: a remote cluster
      // orbits its own center, out of the Firstmate's pull.
      let frame = computer.reachable
        ? local.model.update(local.time, settled, 0)
        : (local.frozen ?? local.model.update(local.time, true, 0));
      if (computer.reachable) {
        local.lastFrame = frame;
        const center = this.positions.get(computer.id);
        local.lastCenter = { x: center?.x ?? 0, y: center?.y ?? 0 };
      } else {
        const center = this.positions.get(computer.id);
        const dx = (center?.x ?? 0) - (local.frozenCenter?.x ?? 0);
        const dy = (center?.y ?? 0) - (local.frozenCenter?.y ?? 0);
        frame = {
          ...frame,
          crew: frame.crew.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
          orbits: frame.orbits.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy })),
          programs: frame.programs.map((p) => ({
            ...p,
            x: p.x + dx,
            y: p.y + dy,
            nodes: p.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
          })),
        };
      }
      const visible = clusters.some((c) => c.id === computer.id);
      const onPage = this.pagePeers().some((peer) => peer.id === computer.id);
      // A cue reaches the Firstmate from any computer on the page, including
      // the last crewmate's fall home, which leaves its computer unseated.
      const cues = local.model.takeCues();
      if (this.multiple && onPage && computer.reachable) this.clusterCues.push(...cues);
      if (!this.multiple || !visible) continue;
      // Unknown activity is never guessed from old heat. Keep last-known
      // position and spin; no packets or review motion on an unreachable Mac.
      frame = {
        ...frame,
        crew: frame.crew.map((c) => ({
          ...c,
          computerId: computer.id,
          // The glyphs keep their size, with home's depth cue: nearer is larger.
          size:
            (count > CLUSTER_LAYOUT.crowdedCrew
              ? CLUSTER_LAYOUT.crowdedGlyphPx
              : CLUSTER_LAYOUT.crewGlyphPx) *
            (0.84 + 0.32 * c.depth),
          ...(!computer.reachable
            ? {
                work: 0,
                wait: undefined,
                waitArc: undefined,
                job: undefined,
                activityUnknown: true,
                status: "idle" as const,
                alpha: c.alpha * 0.45,
                flicker: 0,
                flash: 0,
                nudge: 0,
                streak: undefined,
              }
            : {}),
        })),
        packets: computer.reachable ? frame.packets : [],
      };
      frames.push(frame);
    }
    if (!this.multiple) {
      this.clusterCues = [];
      return legacy;
    }
    return {
      ...legacy,
      clustered: true,
      scene: this.sceneNeed(clusters),
      crew: frames.flatMap((f) => f.crew).sort((a, b) => a.depth - b.depth),
      orbits: frames.flatMap((f) => f.orbits),
      packets: frames.flatMap((f) => f.packets),
      programs: frames.flatMap((f) => f.programs),
      starJoins: frames.flatMap((f) => f.starJoins ?? []),
      links: [
        ...frames.flatMap((f) => f.links),
        ...this.acrossLinks(frames.flatMap((f) => f.crew)),
      ],
    };
  }
}
