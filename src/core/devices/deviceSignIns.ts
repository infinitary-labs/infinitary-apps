import { randomBytes } from "node:crypto";
import { hasSince16, speaksCustomApi } from "@shared/contractFeatures";
import { HERE } from "@shared/deviceNames";
import { type ComputerReach, type DeviceView, deviceRunsWork } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import type { ForgeCliSignInResult } from "@shared/forges";
import { catalogEntry } from "@shared/providers";
import {
  type ComputerSignIns,
  computerSignInsSchema,
  type DeviceSignInEvent,
  type DeviceSignInFlow,
  type DeviceSignIns as DeviceSignInsView,
  type SignInOrderChannel,
  type SignInOrderResponse,
  type SignInStep,
  signInOrders,
  signInPlace,
} from "@shared/signIns";
import { DeviceOutOfReachError, type WorkDeviceContact } from "../connection/connection";
import { contractChange, listsChange } from "../connection/contractChanges";
import type { CoreEventSink } from "../events";
import { narrowServedThere } from "../models/piAccountLists";
import type { WorkDevices } from "../placed/workDevices";

/**
 * The home's side of a computer that runs work signing in to its own
 * subscriptions (docs/helper.md, "Its own sign-ins"): Settings ->
 * Intelligence asks here, and this asks that computer (src/shared/signIns.ts).
 *
 * What it keeps is only in memory, and only what the computer said of
 * itself: its account rows and the allowance it read. The captain's answer
 * to a prompt - a pasted code, a key - passes through `answer` into one
 * order and is held nowhere: not here, not in an event, a feed line, the
 * action trail or a saved file. The home has no store for these accounts,
 * so it can neither renew one nor bind a task of its own to it.
 *
 * The same holds for the computer's own sign-in where projects live, which
 * its clones and pushes use (docs/forge.md, "A computer's own sign-in"):
 * Settings -> Integrations starts the host's device flow there, the code to read
 * comes back as a step, and that computer finishes the sign-in itself.
 */

/** A computer that takes Keep going on credits for its own accounts (`computer-keep-going.md`). */
const COMPUTER_KEEP_GOING = contractChange("computer-keep-going");

type Running = DeviceSignInFlow & {
  /** The person's word for a project host ("GitHub"). */
  readonly name?: string;
};

type Said = { signIns: ComputerSignIns | null; asOf?: number; unanswered?: boolean };

export type DeviceSignInsOptions = {
  /** The paired devices, as pairing lists them. */
  devices: () => DeviceView[];
  work: Pick<WorkDevices, "ask" | "onWorkDevice" | "inReach" | "version">;
  emit: CoreEventSink;
  broadcastEvent: (event: FmEvent) => void;
  /**
   * A computer said something new of its sign-ins: a task there waits on a
   * cut-off it names, and goes on once it no longer does.
   */
  changed?: (deviceId: string) => void;
  /**
   * The ids of one provider a computer's account list may never be trusted
   * to take away: the rail this Mac narrows its own accounts behind, read
   * whenever a computer's list is (`narrowServedThere`). Absent, a
   * computer's Codex and Grok lists stay as Pi's catalog serves them.
   */
  protectedIds?: (providerId: string) => readonly string[];
  /** The one reach value (`reachFrom`). Absent, out of reach. */
  reachOf?: (deviceId: string) => ComputerReach;
  now?: () => number;
};

export class DeviceSignIns {
  private projection: Map<ComputerSignIns | null, ComputerSignIns | null> | undefined;

  /** A read of many task rows narrows each computer's answer once. */
  readProjection<T>(read: () => T): T {
    if (this.projection) return read();
    this.projection = new Map();
    try {
      return read();
    } finally {
      this.projection = undefined;
    }
  }

  private readonly said = new Map<string, Said>();
  private readonly running = new Map<string, Running>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: DeviceSignInsOptions) {
    this.now = options.now ?? Date.now;
    this.unsubscribe = options.work.onWorkDevice((contact) => this.contact(contact));
  }

  /** Each computer that runs work, with what it last said of its sign-ins. */
  view(): DeviceSignInsView[] {
    return this.computers().map((device) => {
      const said = this.said.get(device.id);
      const inReach = this.options.work.inReach(device.id);
      return {
        deviceId: device.id,
        name: device.name,
        ...(device.user ? { user: device.user } : {}),
        onThisMac: device.onThisMac === true,
        reach: this.options.reachOf?.(device.id) ?? (inReach ? "in-reach" : "out-of-reach"),
        customApi: speaksCustomApi(this.options.work.version(device.id)?.contract ?? ""),
        keepGoing: this.takesKeepGoing(device.id),
        signIns: this.narrowed(said?.signIns ?? null),
        flows: [...this.running.values()]
          .filter((flow) => flow.deviceId === device.id)
          .map(({ name: _name, ...flow }) => flow),
        ...(said?.asOf !== undefined ? { asOf: said.asOf } : {}),
        ...(said?.unanswered ? { unanswered: true } : {}),
      };
    });
  }

  /**
   * The window's read: every computer in reach that has said nothing yet is
   * asked, and its answer arrives as a push. One that refused is asked again
   * when it next comes into reach.
   */
  read(): DeviceSignInsView[] {
    for (const device of this.computers())
      if (!this.said.has(device.id) && this.options.work.inReach(device.id))
        void this.ask(device.id);
    return this.view();
  }

  /**
   * What one computer last said of its sign-ins, for routing a task there
   * (docs/helper.md, "Its own sign-ins"): asked now when it has said nothing
   * yet and is in reach, as a task about to run there would load them
   * anyway. Null when it cannot say.
   */
  async signInsOf(deviceId: string): Promise<ComputerSignIns | null> {
    if (!this.said.get(deviceId)?.signIns && this.options.work.inReach(deviceId))
      await this.ask(deviceId);
    return this.narrowed(this.said.get(deviceId)?.signIns ?? null);
  }

  /**
   * What one computer last said of its sign-ins, read now without asking:
   * null when it has said nothing since this Mac started, or could not.
   */
  lastSaid(deviceId: string): ComputerSignIns | null {
    return this.narrowed(this.said.get(deviceId)?.signIns ?? null);
  }

  /**
   * Asks one computer its sign-ins again, after any ask already on its way,
   * and resolves once it answered or could not: what it says then was
   * written after everything the home heard from it before this call, such
   * as a turn there that met a cut-off.
   */
  async refresh(deviceId: string): Promise<void> {
    await this.reading.get(deviceId);
    if (this.options.work.inReach(deviceId)) await this.ask(deviceId);
  }

  /** Starts a sign-in on that computer; its steps arrive as `inf:devices:sign-in`. */
  async start(
    deviceId: string,
    providerId: string,
    type: "oauth" | "api_key",
    accountId?: string,
  ): Promise<{ signInId: string }> {
    const device = this.computer(deviceId);
    const words = signInPlace({ ...device, onThisMac: device.onThisMac === true });
    const signInId = randomBytes(16).toString("base64url");
    this.begin({
      signInId,
      deviceId,
      providerId,
      target: "account",
      phase: "running",
      ...(accountId ? { accountId } : {}),
    });
    try {
      if (!this.options.work.inReach(deviceId))
        throw new Error(`${words.who} is out of reach, so no sign-in started.`);
      await this.options.work.ask(deviceId, "inf:sign-ins:start", [
        { signInId, providerId, type, ...(accountId ? { accountId } : {}) },
      ]);
    } catch (error) {
      this.end(signInId, {
        kind: "ended",
        outcome: "failed",
        error: reachable(error, words.who).message,
      });
      throw reachable(error, words.who);
    }
    return { signInId };
  }

  /**
   * Starts that computer's own sign-in where a project lives (GitHub's
   * device flow) there; its code to read and its end arrive as
   * `inf:devices:sign-in`, and `cancel` stops it.
   */
  async startForge(deviceId: string, host: string): Promise<{ signInId: string }> {
    const device = this.computer(deviceId);
    const words = signInPlace({ ...device, onThisMac: device.onThisMac === true });
    const offered = this.said
      .get(deviceId)
      ?.signIns?.forges?.hosts.find((entry) => entry.host === host);
    const signInId = randomBytes(16).toString("base64url");
    this.begin({
      signInId,
      deviceId,
      providerId: host,
      target: "forge",
      phase: "running",
      ...(offered ? { name: offered.name } : {}),
    });
    try {
      if (!offered)
        throw new Error(
          `${words.who} does not offer a sign-in there. It may need ${HERE.this}'s version of Infinitary.`,
        );
      if (!this.options.work.inReach(deviceId))
        throw new Error(`${words.who} is out of reach, so no sign-in started.`);
      await this.options.work.ask(deviceId, "inf:sign-ins:forge", [{ signInId, host }]);
    } catch (error) {
      this.end(signInId, {
        kind: "ended",
        outcome: "failed",
        error: reachable(error, words.who).message,
      });
      throw reachable(error, words.who);
    }
    return { signInId };
  }

  /**
   * Signs that computer in where a project lives through its own GitHub
   * CLI's sign-in, there; only a computer whose forges say `githubCli` is
   * asked. Nothing crosses but the host and whether it was kept, so no
   * token is here, in an event or a feed line; the rows it changed arrive as
   * that computer's sign-ins.
   */
  async forgeWithCli(deviceId: string, host: string): Promise<ForgeCliSignInResult> {
    const device = this.computer(deviceId);
    const words = signInPlace({ ...device, onThisMac: device.onThisMac === true });
    const forges = this.said.get(deviceId)?.signIns?.forges;
    if (!forges?.githubCli || !forges.hosts.some((entry) => entry.host === host))
      throw new Error(`${words.who} does not offer GitHub CLI's sign-in there.`);
    if (!this.options.work.inReach(deviceId))
      throw new Error(`${words.who} is out of reach, so nothing was asked.`);
    let answer: unknown;
    try {
      answer = await this.options.work.ask(deviceId, "inf:sign-ins:forge-cli", [{ host }]);
    } catch (error) {
      throw reachable(error, words.who);
    }
    const parsed = signInOrders["inf:sign-ins:forge-cli"].response.safeParse(answer);
    if (!parsed.success)
      throw new Error(`${words.who} answered in a shape ${HERE.this} does not know.`);
    return parsed.data;
  }

  /**
   * Forwards one custom API order to that computer. The key rides inside
   * connect's arguments and is held nowhere here: not in this object, an
   * event, or a feed line. The answer is a view, never the key.
   */
  async custom<C extends SignInOrderChannel>(
    deviceId: string,
    channel: C,
    args: unknown[],
  ): Promise<SignInOrderResponse<C>> {
    this.computer(deviceId);
    const who = this.who(deviceId);
    const version = this.options.work.version(deviceId);
    if (!speaksCustomApi(version?.contract ?? ""))
      throw new Error(`Update Infinitary on ${who} first.`);
    // Sign-in orders cross majors, so an older computer has token commands only by their name.
    if (
      channel === "inf:sign-ins:custom-connect" &&
      args[0] &&
      typeof args[0] === "object" &&
      "tokenCommand" in args[0] &&
      !hasSince16(version?.contract, version?.changes, "custom-token-command")
    )
      throw new Error(`Update Infinitary on ${who} before saving a token command.`);
    if (!this.options.work.inReach(deviceId))
      throw new Error(`${who} is out of reach, so nothing was sent.`);
    let answer: unknown;
    try {
      answer = await this.options.work.ask(deviceId, channel, args);
    } catch (error) {
      throw reachable(error, who);
    }
    const parsed = signInOrders[channel].response.safeParse(answer);
    if (!parsed.success) throw new Error(`${who} answered in a shape ${HERE.this} does not know.`);
    return parsed.data as SignInOrderResponse<C>;
  }

  /**
   * Turns Keep going on credits on or off for one of that computer's own
   * accounts (docs/quota.md), saved only there. Only the account id and the
   * switch cross; its rows come back as that computer's sign-ins, whole,
   * and this resolves once they have.
   */
  async keepGoing(deviceId: string, accountId: string, on: boolean): Promise<{ ok: true }> {
    this.computer(deviceId);
    const who = this.who(deviceId);
    if (!this.takesKeepGoing(deviceId))
      throw new Error(`Update Infinitary on ${who} to keep going on credits there.`);
    if (!this.said.get(deviceId)?.signIns?.accounts.some((account) => account.id === accountId))
      throw new Error(`${who} has no account with that id. Look in Settings → Intelligence.`);
    if (!this.options.work.inReach(deviceId))
      throw new Error(`${who} is out of reach, so nothing was sent.`);
    try {
      await this.options.work.ask(deviceId, "inf:sign-ins:keep-going", [{ accountId, on }]);
    } catch (error) {
      throw reachable(error, who);
    }
    await this.refresh(deviceId);
    return { ok: true };
  }

  /** Whether that computer takes `inf:sign-ins:keep-going` (`computer-keep-going.md`). */
  takesKeepGoing(deviceId: string): boolean {
    return listsChange(this.options.work.version(deviceId)?.changes, COMPUTER_KEEP_GOING);
  }

  /** Signs that computer out where a project lives; its sign-in there is deleted. */
  async signOutForge(deviceId: string, host: string): Promise<{ ok: true }> {
    this.computer(deviceId);
    try {
      await this.options.work.ask(deviceId, "inf:sign-ins:forge-out", [{ host }]);
    } catch (error) {
      throw reachable(error, this.who(deviceId));
    }
    return { ok: true };
  }

  /**
   * What the captain typed or chose for one prompt, sent to that computer
   * once. Nothing here keeps it, and it never rides an event.
   */
  async answer(signInId: string, promptId: string, value: string | null): Promise<{ ok: true }> {
    const running = this.running.get(signInId);
    if (running?.phase !== "running") throw new Error("That sign-in is no longer running.");
    if (running.prompt?.promptId !== promptId)
      throw new Error("That sign-in is no longer waiting for an answer.");
    const { prompt: _prompt, ...answered } = running;
    this.running.set(signInId, answered);
    this.push();
    try {
      await this.options.work.ask(running.deviceId, "inf:sign-ins:answer", [
        { signInId, promptId, value },
      ]);
    } catch (error) {
      // A refused send can be answered again, but never restore a prompt over
      // a newer step or an end that arrived while the order was on its way.
      if (this.running.get(signInId) === answered) {
        this.running.set(signInId, running);
        this.push();
      }
      throw reachable(error, this.who(running.deviceId));
    }
    return { ok: true };
  }

  /** Stops a sign-in wherever it waits; its end arrives as a step. */
  async cancel(signInId: string): Promise<{ ok: true }> {
    const running = this.running.get(signInId);
    if (!running) return { ok: true };
    if (running.phase === "ended") {
      this.running.delete(signInId);
      this.push();
      return { ok: true };
    }
    this.end(signInId, { kind: "ended", outcome: "cancelled" });
    try {
      await this.options.work.ask(running.deviceId, "inf:sign-ins:cancel", [{ signInId }]);
    } catch {
      // The computer stops old work when contact is lost or welcomed again.
    }
    return { ok: true };
  }

  /**
   * Signs that computer out of one of its own accounts. The feed says so,
   * and for Claude what became of that computer's own Claude login, as the
   * computer answered.
   */
  async signOut(deviceId: string, accountId: string): Promise<{ ok: true }> {
    this.computer(deviceId);
    const providerId = this.said
      .get(deviceId)
      ?.signIns?.accounts.find((account) => account.id === accountId)?.providerId;
    let answer: unknown;
    try {
      answer = await this.options.work.ask(deviceId, "inf:sign-ins:remove", [{ accountId }]);
    } catch (error) {
      throw reachable(error, this.who(deviceId));
    }
    const parsed = signInOrders["inf:sign-ins:remove"].response.safeParse(answer);
    const login = parsed.success ? parsed.data.login : undefined;
    if (providerId)
      this.options.broadcastEvent({
        type: "device_signed_out",
        deviceId,
        who: this.who(deviceId),
        provider: catalogEntry(providerId)?.name ?? providerId,
        ...(login ? { login } : {}),
      });
    return { ok: true };
  }

  /** `inf:work:sign-in`: one step of a sign-in that computer runs for this home. */
  step(deviceId: string, request: { signInId: string; step: SignInStep }): { ok: true } {
    const running = this.running.get(request.signInId);
    if (!running || running.deviceId !== deviceId)
      throw new Error("No sign-in of this home runs on that computer.");
    if (request.step.kind === "ended") this.end(request.signInId, request.step);
    else if (running.phase === "running") {
      const step = request.step;
      const next =
        step.kind === "prompt"
          ? { ...running, prompt: step.prompt }
          : {
              ...running,
              notice: step.notice,
              ...(step.notice.url ? { link: step.notice.url } : {}),
            };
      this.running.set(request.signInId, next);
      this.tell(request.signInId, next, step);
    }
    return { ok: true };
  }

  /** `inf:work:sign-ins`: that computer's sign-ins, whole, after a change. */
  changed(deviceId: string, signIns: ComputerSignIns): { ok: true } {
    this.computer(deviceId);
    this.said.set(deviceId, { signIns, asOf: this.now() });
    this.push();
    this.options.emit("inf:models:changed", { ok: true });
    this.options.changed?.(deviceId);
    return { ok: true };
  }

  dispose(): void {
    this.unsubscribe();
    for (const [id, running] of this.running)
      if (running.phase === "running") this.end(id, { kind: "ended", outcome: "cancelled" });
    this.running.clear();
  }

  /** What a computer said, its Codex and Grok lists narrowed behind this Mac's rail. */
  private narrowed(signIns: ComputerSignIns | null): ComputerSignIns | null {
    if (this.projection?.has(signIns)) return this.projection.get(signIns) ?? null;
    const protectedIds = this.options.protectedIds;
    const narrowed = protectedIds ? narrowServedThere(signIns, protectedIds) : signIns;
    this.projection?.set(signIns, narrowed);
    return narrowed;
  }

  private contact(contact: WorkDeviceContact): void {
    // Quick redial can keep the computer in reach without running its dropped
    // cleanup. End the old view here and cancel its work through the new link.
    for (const [signInId, running] of [...this.running]) {
      if (running.deviceId !== contact.deviceId) continue;
      if (running.phase === "running")
        this.end(signInId, {
          kind: "ended",
          outcome: "failed",
          error:
            contact.contact === "gone"
              ? `${this.who(contact.deviceId)} went out of reach, so the sign-in stopped.`
              : `${this.who(contact.deviceId)} reconnected, so the earlier sign-in stopped. Try signing in again.`,
        });
      if (contact.contact === "in-reach")
        void this.options.work
          .ask(contact.deviceId, "inf:sign-ins:cancel", [{ signInId }])
          .catch(() => {});
    }
    if (contact.contact === "in-reach" && this.said.has(contact.deviceId))
      void this.ask(contact.deviceId);
    this.push();
  }

  private ask(deviceId: string): Promise<void> {
    let pending = this.reading.get(deviceId);
    if (pending) return pending;
    pending = this.options.work
      .ask(deviceId, "inf:sign-ins:list", [])
      .then(
        (answer) => {
          const parsed = computerSignInsSchema.safeParse(answer);
          this.said.set(
            deviceId,
            parsed.success
              ? { signIns: parsed.data, asOf: this.now() }
              : { ...this.said.get(deviceId), signIns: null, unanswered: true },
          );
          if (parsed.success) {
            this.options.emit("inf:models:changed", { ok: true });
            this.options.changed?.(deviceId);
          }
        },
        (error: unknown) => {
          // Out of reach is a state, not an answer; anything else is a refusal.
          if (!(error instanceof DeviceOutOfReachError))
            this.said.set(deviceId, { signIns: null, unanswered: true });
        },
      )
      .finally(() => {
        this.reading.delete(deviceId);
        this.push();
      });
    this.reading.set(deviceId, pending);
    return pending;
  }

  private begin(flow: Running): void {
    for (const [id, previous] of this.running)
      if (previous.deviceId === flow.deviceId && previous.target === flow.target)
        void this.cancel(id);
    this.running.set(flow.signInId, flow);
    this.push();
  }

  private end(signInId: string, step: Extract<SignInStep, { kind: "ended" }>): void {
    const running = this.running.get(signInId);
    if (!running || running.phase === "ended") return;
    const { prompt: _prompt, ...identity } = running;
    if (step.outcome === "signed-in" || step.outcome === "cancelled") this.running.delete(signInId);
    else this.running.set(signInId, { ...identity, phase: "ended", ended: step });
    this.tell(signInId, running, step);
    if (step.outcome === "signed-in")
      this.options.broadcastEvent({
        type: "device_signed_in",
        deviceId: running.deviceId,
        who: this.who(running.deviceId),
        provider: running.name ?? catalogEntry(running.providerId)?.name ?? running.providerId,
      });
  }

  private tell(signInId: string, running: Running, step: SignInStep): void {
    const event: DeviceSignInEvent = {
      signInId,
      deviceId: running.deviceId,
      providerId: running.providerId,
      ...(running.accountId ? { accountId: running.accountId } : {}),
      step,
    };
    this.options.emit("inf:devices:sign-in", event);
  }

  /** A computer's connection moved: the window draws it again. */
  pushView(): void {
    this.push();
  }

  private push(): void {
    this.projection?.clear();
    this.options.emit("inf:devices:sign-ins", this.view());
  }

  private computers(): DeviceView[] {
    return this.options.devices().filter((device) => deviceRunsWork(device.kind));
  }

  private computer(deviceId: string): DeviceView {
    const device = this.computers().find((candidate) => candidate.id === deviceId);
    if (!device)
      throw new Error("No computer that runs work has that id. Look in Settings → Devices.");
    return device;
  }

  /** How words name a computer that runs work (`signInPlace`); undefined for no such computer. */
  placeOf(deviceId: string): ReturnType<typeof signInPlace> | undefined {
    const device = this.computers().find((candidate) => candidate.id === deviceId);
    return device ? signInPlace({ ...device, onThisMac: device.onThisMac === true }) : undefined;
  }

  private who(deviceId: string): string {
    const device = this.computers().find((candidate) => candidate.id === deviceId);
    return device
      ? signInPlace({ ...device, onThisMac: device.onThisMac === true }).who
      : "That computer";
  }
}

/** A refusal in the words the window shows: out of reach says so, anything else is the computer's own. */
function reachable(error: unknown, who: string): Error {
  if (error instanceof DeviceOutOfReachError)
    return new Error(`${who} is out of reach, so nothing was sent.`);
  return error instanceof Error ? error : new Error(String(error));
}
