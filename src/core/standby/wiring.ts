import { join } from "node:path";
import { deviceLabel, deviceRunsWork } from "@shared/devices";
import type { HomeMoveGap } from "@shared/homeMove";
import { catalogEntry } from "@shared/providers";
import {
  type OtherHome,
  STANDBY_CHANGE,
  STANDBY_SECRETS_CHANGE,
  STANDBY_TAKE_OVER_CHANGE,
  type StandbyLock,
  type StandbyReady,
  type StandbyView,
  type StandbyViews,
} from "@shared/standby";
import {
  type CopyPeer,
  STANDBY_PEERS_CHANGE,
  STANDBY_PEERS_ORDER,
  standbyPeersOrders,
} from "@shared/standbyPeers";
import { defaultClaudeConfigDir } from "../claude/claudeQuota";
import type { CoreServices } from "../coreServices";
import { dialHome } from "../devices/dial";
import { JoinedHome } from "../devices/joinedHome";
import type { CoreEventSink } from "../events";
import type { HomeHandOver, OutgoingHomeMove } from "../homeMove/outgoing";
import { MOVED_AWAY_DIR } from "../homeMove/record";
import { hostEnv } from "../hostEnv";
import type { SecretCustody } from "../secrets/custody";
import { KNOWLEDGE_DB_FILE } from "../storage/knowledgeStore";
import { StandbySecrets } from "./secrets";
import { hearHomeAs, neverSentLines, StepDownWatch } from "./stepDown";
import { StandbyStream } from "./stream";
import { STANDBY_WORDS } from "./words";

/** Where the home keeps the stream's changes until every copy has them; never part of the record. */
export const STANDBY_STAGING = "standby-stream";

/** How long what a copy is told of the home is read once for every copy, as fresh as a look over. */
const FACTS_FRESH_MS = 60_000;

/** The home's side of keeping copies on other computers, over the core's own services. */
export type Standbys = {
  stream: StandbyStream;
  /** Where each copy stands, with whether it keeps the first mate's secrets, and a second home that answers with this one's number. */
  views: () => StandbyViews;
  /** The captain's choice between two homes with one number: "here", or the other's id. */
  keepHome: (choice: string) => { ok: boolean; text: string };
  /** A window heard another home with this one's number, which this home may not reach itself. */
  otherHome: (other: OtherHome) => { ok: boolean };
  name: (deviceId: string, on: boolean) => { ok: boolean; text: string };
  /** The captain's Keep secrets there (docs/devices.md, "Secrets on a computer that keeps a copy"). */
  keepSecrets: (deviceId: string) => Promise<{ ok: boolean; text: string }>;
  ready: (deviceId: string) => Promise<StandbyReady>;
  dispose: () => void;
};

export function standbyCopies(
  services: CoreServices,
  emit: CoreEventSink,
  subscribe: (sink: CoreEventSink) => () => void,
  homeMove: OutgoingHomeMove,
  back: {
    /** This computer's own name, which its way back carries. */
    ownName: () => Promise<string>;
    /** A computer that kept a copy took over: the first mate stops here and this computer opens as a Mac of it. */
    stepDown: (handOver: HomeHandOver) => void;
  },
  /** This computer's own lock, should this first mate have started here from a copy. */
  ownLock?: SecretCustody,
): Standbys {
  const userData = services.paths.userData;
  const workDevices = services.workDevices;
  const computer = (deviceId: string) => {
    const device = services.computers.list().find((each) => each.id === deviceId);
    return device
      ? {
          name: deviceLabel(device),
          runsWork: deviceRunsWork(device.kind),
          mac: device.system === "macos",
        }
      : undefined;
  };
  // Whether a computer in reach lists a contract change.
  const speaks = (deviceId: string, change: string) =>
    workDevices.inReach(deviceId) &&
    (workDevices.version(deviceId)?.changes?.includes(change) ?? false);
  // Whether this copy reaches each other copy (docs/devices.md, "Copies that
  // reach each other"), as it says: nothing while it is out of reach or
  // cannot keep a copy, which its own line says.
  const peerLines = async (deviceId: string, name: string): Promise<HomeMoveGap[]> => {
    const others = stream.named().filter((each) => each !== deviceId);
    if (others.length === 0 || !speaks(deviceId, STANDBY_CHANGE)) return [];
    if (!speaks(deviceId, STANDBY_PEERS_CHANGE))
      return [{ id: "peers", level: "blocks", text: STANDBY_WORDS.peersOlder(name) }];
    let heard: CopyPeer[];
    try {
      heard = standbyPeersOrders[STANDBY_PEERS_ORDER].response.parse(
        await workDevices.ask(deviceId, STANDBY_PEERS_ORDER, []),
      ).peers;
    } catch (error) {
      console.warn(`[standby] could not hear which copies ${deviceId} reaches: ${String(error)}`);
      return [];
    }
    return others.map((otherId): HomeMoveGap => {
      const other = computer(otherId);
      const otherName = other?.name ?? otherId;
      const id = `peer-${otherId}`.slice(0, 64);
      const state = heard.find((each) => each.deviceId === otherId)?.state ?? "no-address";
      if (state === "in-reach")
        return { id, level: "notes", text: STANDBY_WORDS.peerReaches(name, otherName) };
      if (workDevices.inReach(otherId) && !speaks(otherId, STANDBY_PEERS_CHANGE))
        return { id, level: "blocks", text: STANDBY_WORDS.peerOlder(otherName) };
      if (state === "no-address")
        return { id, level: "blocks", text: STANDBY_WORDS.peerNoAddress(name, otherName) };
      const bothMacs = Boolean(computer(deviceId)?.mac && other?.mac);
      return {
        id,
        level: "blocks",
        text: STANDBY_WORDS.peerUnreached(name, otherName, bothMacs),
      };
    });
  };
  let facts: {
    at: number;
    read: Promise<Awaited<ReturnType<OutgoingHomeMove["takeOverFacts"]>> | null>;
  } | null = null;
  const stream = new StandbyStream({
    userData,
    claudeDir: defaultClaudeConfigDir(hostEnv()),
    stagingDir: join(userData, STANDBY_STAGING),
    pagesDatabases: () => [
      { path: "firstmate.db", connection: () => services.recordDatabase },
      {
        path: `knowledge/${KNOWLEDGE_DB_FILE}`,
        connection: () => services.knowledge?.openConnection() ?? null,
      },
    ],
    ask: (deviceId, channel, args) => workDevices.ask(deviceId, channel, args),
    inReach: (deviceId) => workDevices.inReach(deviceId),
    addressesChanged: () => {
      void workDevices.tellRoutes();
      emit("inf:standby:views", views());
    },
    speaksCopy: (deviceId) => speaks(deviceId, STANDBY_CHANGE),
    onReach: (listener) => workDevices.onWorkDevice((contact) => listener(contact.deviceId)),
    speaksTakeOver: (deviceId) =>
      workDevices.version(deviceId)?.changes?.includes(STANDBY_TAKE_OVER_CHANGE) ?? false,
    homeFacts: () => {
      // Read once a minute at most: each project's remotes are read with git.
      const now = Date.now();
      if (!facts || now - facts.at > FACTS_FRESH_MS)
        facts = {
          at: now,
          read: homeMove.takeOverFacts().catch((error: unknown) => {
            console.warn(`[standby] could not read what taking over needs: ${String(error)}`);
            return null;
          }),
        };
      return facts.read;
    },
    nameOf: (deviceId) => computer(deviceId)?.name ?? deviceId,
    emit: () => emit("inf:standby:views", views()),
    log: (line) => console.warn(`[standby] ${line}`),
  });
  const speaksSecrets = (deviceId: string) => speaks(deviceId, STANDBY_SECRETS_CHANGE);
  // The first mate's secrets kept with each copy (docs/devices.md, "Secrets
  // on a computer that keeps a copy"): sealed in the record, so the stream
  // carries them like any other change.
  const secrets = new StandbySecrets({
    userData,
    secrets: services.secrets.shown() ? services.secrets : undefined,
    ownLock,
    speaks: speaksSecrets,
    ask: (deviceId, channel, args) => workDevices.ask(deviceId, channel, args),
    listed: () => stream.listed(),
    changed: () => emit("inf:standby:views", views()),
    log: (line) => console.warn(`[standby] ${line}`),
  });
  function decorated(views: StandbyView[]): StandbyView[] {
    return views.map((view) => ({ ...view, secrets: secrets.state(view.deviceId) }));
  }
  // A computer no longer on the list keeps no copy: removed, or the
  // computer this first mate now runs on after a move.
  const sweep = () => {
    for (const deviceId of stream.listed())
      if (!computer(deviceId)?.runsWork) stream.forget(deviceId);
    void secrets.sweep();
  };
  const views = (): StandbyViews => {
    const second = watch.twoHomes();
    return { standbys: decorated(stream.views()), ...(second ? { twoHomes: second } : {}) };
  };
  // An old home that returns (docs/devices.md, "An old home that returns"):
  // while copies are kept, this home keeps a way back to whichever of them
  // takes over, and listens for one that did while it was out of reach.
  const watch = new StepDownWatch({
    returning: () => {
      if (stream.named().length === 0) return null;
      const takeOver = services.devices.takeOver();
      // A home that took over dials as the Mac it was, which another copy that took over lists too.
      const before = takeOver
        ? new JoinedHome(join(userData, MOVED_AWAY_DIR, takeOver, "joined"), () => {}).read()
        : null;
      return before
        ? { deviceId: before.grant.deviceId, key: before.grant.key, cert: before.grant.cert }
        : services.devices.ownReturning();
    },
    homeKey: () => services.devices.identity().pin,
    homeNumber: () => services.devices.homeNumber(),
    takeOver: () => services.devices.takeOver(),
    copies: () =>
      stream.kept().map((each) => ({
        ...each,
        name: computer(each.deviceId)?.name ?? each.deviceId,
        inReach: workDevices.inReach(each.deviceId),
      })),
    onReach: (listener) => workDevices.onWorkDevice(() => listener()),
    hear: (grant) => hearHomeAs(grant, (to) => dialHome(to)),
    neverSent: (since) => neverSentLines(services.recordDatabase, since),
    userData,
    stepDown: (handOver) => back.stepDown(handOver),
    twoHomes: (other) => {
      services.settledBeforeAct.hold(other !== null);
      emit("inf:standby:views", views());
    },
    log: (line) => console.warn(`[standby] ${line}`),
  });
  let disposed = false;
  // The way back is on the record's list while any copy is kept, and goes with the last.
  let wayBack = Promise.resolve();
  const keepWayBack = () => {
    wayBack = wayBack.then(async () => {
      try {
        if (stream.named().length === 0) services.devices.dropReturning();
        else services.devices.returningIdentity(await back.ownName());
      } catch (error) {
        console.warn(`[standby] could not keep this home's way back: ${String(error)}`);
      }
    });
  };
  // A first mate started from a copy takes the secrets sealed to this
  // computer's own lock first, before any sealing of its own.
  void secrets.adopt().then(() => sweep());
  keepWayBack();
  stream.start();
  watch.start();
  services.devices.offerCopies(
    () => stream.addresses(),
    () => stream.listening(),
  );
  services.settledBeforeAct.follow(() => stream.settled());
  const stopHearing = subscribe((channel) => {
    if (channel === "inf:devices") sweep();
    if (channel === "inf:secrets:changed") void secrets.seal();
  });
  // What this first mate uses that the computer has no sign-in of its own for.
  const missingSignIns = async (deviceId: string) => {
    const there = await services.deviceSignIns.signInsOf(deviceId).catch(() => null);
    if (!there) return undefined;
    const providersThere = new Set(there.accounts.map((account) => account.providerId));
    const providers = new Map<string, string>();
    for (const account of services.vault.list())
      if (!providersThere.has(account.providerId) && !providers.has(account.providerId))
        providers.set(
          account.providerId,
          (catalogEntry(account.providerId)?.name ?? account.label).slice(0, 64),
        );
    const forgesThere = new Set((there.forges?.signIns ?? []).map((signIn) => signIn.host));
    const forges = services.forges
      .view()
      .signIns.filter((signIn) => !forgesThere.has(signIn.host))
      .map((signIn) => ({ host: signIn.host, name: signIn.name }));
    return {
      providers: [...providers].map(([id, name]) => ({ id, name })).slice(0, 32),
      forges: forges.slice(0, 16),
    };
  };
  return {
    stream,
    name: (deviceId, on) => {
      const found = computer(deviceId);
      const name = found?.name ?? deviceId;
      if (on && !found?.runsWork) return { ok: false, text: STANDBY_WORDS.notWork(name) };
      stream.name(deviceId, on);
      keepWayBack();
      if (!on) {
        void secrets.sweep();
        return { ok: true, text: STANDBY_WORDS.stopped(name) };
      }
      // Its own sign-ins are made once, from this window (decision of the plan).
      const said = services.deviceSignIns.lastSaid(deviceId);
      const missing = said
        ? [
            ...services.vault
              .list()
              .filter(
                (account) => !said.accounts.some((one) => one.providerId === account.providerId),
              )
              .map((account) => catalogEntry(account.providerId)?.name ?? account.label),
            ...services.forges
              .view()
              .signIns.filter(
                (signIn) => !(said.forges?.signIns ?? []).some((one) => one.host === signIn.host),
              )
              .map((signIn) => signIn.name),
          ]
        : [];
      const unique = [...new Set(missing)];
      return {
        ok: true,
        text: unique.length
          ? `${STANDBY_WORDS.keeping(name)} ${STANDBY_WORDS.keepingSignIns(unique)}`
          : STANDBY_WORDS.keeping(name),
      };
    },
    keepSecrets: async (deviceId) => {
      const name = computer(deviceId)?.name ?? deviceId;
      if (!stream.listed().includes(deviceId))
        return { ok: false, text: STANDBY_WORDS.notKept(name) };
      if (!secrets.offered()) return { ok: false, text: STANDBY_WORDS.secretsUnopened };
      if (!workDevices.inReach(deviceId))
        return { ok: false, text: STANDBY_WORDS.secretsAway(name) };
      if (!speaksSecrets(deviceId))
        return { ok: false, text: STANDBY_WORDS.secretsNeedsUpdate(name) };
      const state: StandbyLock["state"] = await secrets.keep(deviceId);
      if (state === "kept") return { ok: true, text: STANDBY_WORDS.secretsKept(name) };
      if (state === "asking") return { ok: true, text: STANDBY_WORDS.secretsAsking(name) };
      if (state === "refused") return { ok: false, text: STANDBY_WORDS.secretsRefused(name) };
      return { ok: false, text: STANDBY_WORDS.secretsCannot(name) };
    },
    ready: async (deviceId) => {
      // What taking over needs is what a move there needs, a copy in sync,
      // and the other copies in reach of it.
      const move = await homeMove.ready(deviceId);
      const view = stream.view(deviceId);
      const name = move.name;
      const copy: HomeMoveGap = !view
        ? { id: "copy", level: "blocks", text: STANDBY_WORDS.notKept(name) }
        : view.state === "in-sync"
          ? { id: "copy", level: "notes", text: STANDBY_WORDS.inSync(name) }
          : view.state === "catching-up"
            ? {
                id: "copy",
                level: "blocks",
                text: STANDBY_WORDS.catchingUp(name, view.behind ?? 0),
              }
            : view.state === "away"
              ? { id: "copy", level: "blocks", text: STANDBY_WORDS.away(name) }
              : view.state === "needs-update"
                ? { id: "copy", level: "blocks", text: STANDBY_WORDS.needsUpdate(name) }
                : { id: "copy", level: "blocks", text: STANDBY_WORDS.copying(name) };
      // Its secrets and its own sign-ins take the place of the move's notes
      // on them: a takeover carries the secrets kept there and no sign-in.
      const kept = secrets.state(deviceId);
      const sealedState = await services.secrets.sealedState();
      const hasSecrets = sealedState?.revisions.length ?? 0;
      const secretsGap: HomeMoveGap[] =
        kept === "kept"
          ? [{ id: "secrets", level: "notes", text: STANDBY_WORDS.secretsKept(name) }]
          : kept === "asking"
            ? [{ id: "secrets", level: "blocks", text: STANDBY_WORDS.secretsAsking(name) }]
            : // Secrets not open here now: the move's own line on them says what it can.
              !sealedState
              ? move.gaps.filter((gap) => gap.id === "secrets")
              : hasSecrets > 0
                ? [
                    {
                      id: "secrets",
                      level: "blocks",
                      text: !workDevices.inReach(deviceId)
                        ? STANDBY_WORDS.secretsAway(name)
                        : speaksSecrets(deviceId)
                          ? STANDBY_WORDS.secretsNone(name)
                          : STANDBY_WORDS.secretsNeedsUpdate(name),
                    },
                  ]
                : [];
      const peers = await peerLines(deviceId, name);
      const missing = await missingSignIns(deviceId);
      const signIns = missing
        ? [...missing.providers, ...missing.forges].map((each) => each.name)
        : [];
      // A first mate that uses no sign-in has no line to say about them.
      const usesSignIns = services.vault.list().length + services.forges.view().signIns.length;
      const signInGap: HomeMoveGap[] = !missing
        ? [{ id: "sign-ins", level: "notes", text: STANDBY_WORDS.signInsUnknown(name) }]
        : signIns.length
          ? [{ id: "sign-ins", level: "blocks", text: STANDBY_WORDS.signInsMissing(name, signIns) }]
          : usesSignIns > 0
            ? [{ id: "sign-ins", level: "notes", text: STANDBY_WORDS.signInsThere(name) }]
            : [];
      const rest = move.gaps.filter((gap) => gap.id !== "secrets" && gap.id !== "sign-ins");
      return {
        deviceId,
        name,
        gaps: [copy, ...peers, ...secretsGap, ...signInGap, ...rest].slice(0, 64),
        ...(missing ? { missing } : {}),
      };
    },
    views,
    otherHome: (other) => ({ ok: watch.reported(other) }),
    keepHome: (choice) => {
      const second = watch.twoHomes();
      if (!second) return { ok: false, text: STANDBY_WORDS.noTwoHomes };
      const kept = watch.keep(choice, (homeNumber) => services.devices.raiseHomeNumber(homeNumber));
      if (!kept) return { ok: false, text: STANDBY_WORDS.noTwoHomes };
      return {
        ok: true,
        text:
          choice === "here"
            ? STANDBY_WORDS.keptHere(second.name)
            : STANDBY_WORDS.keptOther(second.name),
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      watch.dispose();
      services.devices.offerCopies(null);
      services.settledBeforeAct.follow(null);
      stopHearing();
      secrets.dispose();
      stream.dispose();
    },
  };
}
