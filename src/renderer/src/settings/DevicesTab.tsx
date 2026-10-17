import type { DeviceMake } from "@shared/cards";
import { aDevice, anotherUserHere, COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceAddresses,
  type DeviceFirewall,
  type DeviceInvite,
  type DeviceRemoveWhen,
  type DeviceView,
  deviceConnecting,
  deviceJoinedLine,
  deviceLabel,
  deviceRunsWork,
  deviceWords,
  firewallWords,
  namesInWords,
  userDisplayName,
} from "@shared/devices";
import {
  NEARBY_OFF,
  NEARBY_RENEW_MS,
  type NearbyMacsView,
  nearbyAddress,
  nearbyMacsWords,
  nearbyOnList,
} from "@shared/nearbyMacs";
import { catalogEntry } from "@shared/providers";
import {
  type RemoteLoginConfirmQuestion,
  type RemoteLoginCopy,
  type RemoteLoginLeaveQuestion,
  type RemoteLoginPasswordQuestion,
  remoteLoginRefusalLines,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { type DeviceSignIns, signInPlace } from "@shared/signIns";
import { runsForAnotherFirstmate, sshConnectionWords } from "@shared/sshConnection";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import "../accounts/connectChips.css";
import { useShellStore } from "../app/store";
import { Button, Input } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { focusWithRing } from "../design/focus";
import { isView } from "../devices/viewWords";
import { ControllingTab } from "./ControllingTab";
import { PhoneCode } from "./PhoneCode";
import "./devices.css";
import {
  awayWord,
  CONTROLLING_NOW,
  type DevicePanelMake,
  NO_NEW_WORK,
  PANEL_WORDS,
  RUNS_NO_PROJECT,
  removeLines,
  SEEN_WORDS,
  WAYS_WORDS,
  wayCount,
} from "./devicesWords";
import { SECTION_GAP, SectionLabel, SettingError, SettingRow } from "./settingRows";

/**
 * Settings -> Devices (design skill components/devices/DevicesTab and
 * AddAMac, docs/devices.md): Your devices - this Mac, then each Mac or user
 * added, with when each was last seen, whether a Mac controls this
 * Firstmate now, and what each computer that runs work runs, its sign-ins
 * and its tasks, each with Remove - the link or command that adds one, and
 * where devices find this Mac.
 *
 * A link or a command exists only after the captain's own click, here or on
 * Firstmate's card, and lives in its panel alone: it is held in this
 * window's memory, never saved, so a restart forgets it and the panel is
 * simply gone. A card's button lands here with what to do on arrival
 * (`pendingDeviceArrival`).
 *
 * A Mac added by its address stands in the list while this Mac reaches it
 * and sets it up over Remote Login, and a computer whose Firstmate is
 * updating, or that this Mac is telling where it is now, says so on its row
 * (design skill `components/devices/AddAMac`). Each step is a feed line the
 * core says; the rows follow those steps, in this window's memory alone.
 *
 * A computer out of reach since this Mac's address changed says so, with
 * the way back: a new command for one added by a command (design skill
 * `components/devices/DevicesTab`, "Bringing a computer back").
 *
 * A computer added by its address is reached over this Mac's own SSH, which
 * follows this Mac wherever it listens: its row says where that connection
 * stands - connected using SSH only once its work said hello, connecting
 * while the connection is being made (also right after an operation held it
 * or its work's folder moved), reconnecting while this Mac tries again by
 * itself after a drop, when its work starts or that it
 * could not start, and, when only a person can mend it, why, with Try
 * again - and Change address reaches it somewhere else (design skill
 * `components/devices/DevicesTab`, "Reached over your SSH").
 *
 * A computer connected on another version of Firstmate says so, with
 * Update, which brings it to this Mac's version, or makes the command that
 * does for one too old to update from here.
 */

/** The open link's or command's panel: shown, used by a device, or gone unused. */
export type LinkPanel =
  | { state: "open"; invite: DeviceInvite; make: DevicePanelMake; copied?: boolean }
  | {
      state: "joined";
      line: string;
      work: boolean;
      /** The device that joined, so a later sign-in there can clear the note. */
      deviceId?: string;
      /** The line says it has no sign-ins yet: it goes once one arrives. */
      awaitingSignIn?: boolean;
    }
  | { state: "expired"; make: DevicePanelMake };

/** Whether the joined note claims no sign-ins, and that device now has one. */
export function joinedNoticeClears(
  panel: LinkPanel | null,
  signIns: readonly DeviceSignIns[],
): boolean {
  if (!panel || panel.state !== "joined" || !panel.awaitingSignIn || !panel.deviceId) return false;
  const own = signIns.find((entry) => entry.deviceId === panel.deviceId)?.signIns;
  if (!own) return false;
  return own.accounts.length > 0 || (own.forges?.signIns.length ?? 0) > 0;
}

type PanelStore = {
  panel: LinkPanel | null;
  stopListening: (() => void) | null;
  show: (invite: DeviceInvite, make: DevicePanelMake, copied?: boolean) => void;
  clear: () => void;
};

/**
 * The panel outlives a tab switch, so a link made from a card is still on
 * screen when the captain comes back, and a device that joins while the tab
 * is closed still turns the panel to "joined".
 */
const usePanel = create<PanelStore>((set, get) => ({
  panel: null,
  stopListening: null,
  show: (invite, make, copied = false) => {
    get().stopListening?.();
    const stopListening = window.infinitary.events.on((event) => {
      if (event.type !== "device_joined") return;
      const { panel } = get();
      if (panel?.state !== "open") return;
      get().stopListening?.();
      // A first join says it has no sign-ins yet. That note goes once one arrives.
      const awaitingSignIn = deviceRunsWork(event.kind) && event.again !== true;
      const hearSignIn = awaitingSignIn
        ? window.infinitary.events.on((later) => {
            if (later.type === "device_signed_in" && later.deviceId === event.deviceId)
              get().clear();
          })
        : null;
      set({
        panel: {
          state: "joined",
          line: deviceJoinedLine(event),
          // One that found this Mac again keeps the projects it ran.
          work: deviceRunsWork(event.kind) && !event.again,
          deviceId: event.deviceId,
          awaitingSignIn,
        },
        stopListening: hearSignIn,
      });
    });
    set({
      panel: { state: "open", invite, make, ...(copied ? { copied: true } : {}) },
      stopListening,
    });
  },
  clear: () => {
    get().stopListening?.();
    set({ panel: null, stopListening: null });
  },
}));

/**
 * A Mac this Mac is adding by its address: reaching it - or, on the call
 * that carries the password typed once, letting Firstmate's own key in -
 * then setting it up once it said its name, or, for a computer already on
 * the list (`deviceId`), telling it where this Mac is now; `copy` is how far
 * the copy of Firstmate has gone there since.
 */
export type AddingMac = {
  address: string;
  stage: "reaching" | "letting-in" | "setting-up" | "finding";
  name?: string;
  deviceId?: string;
  copy?: RemoteLoginCopy;
};

/** A computer this Mac is looking for at another address, to reach it there from now on. */
export type MovingMac = { deviceId: string; address: string };

type SetupStore = {
  adding: AddingMac[];
  /** Computers whose Firstmate is updating, by id. */
  updating: string[];
  /** Computers whose address is changing. */
  moving: MovingMac[];
  stopListening: (() => void) | null;
  addFrom: (address: string, stage?: AddingMac["stage"]) => void;
  addDone: (address: string) => void;
  updateFrom: (deviceId: string) => void;
  updateDone: (deviceId: string) => void;
  moveFrom: (moving: MovingMac) => void;
  moveDone: (deviceId: string) => void;
};

/**
 * What is under way over Remote Login, outliving a tab switch like the
 * panel: each step the core says moves the Mac's row on.
 */
const useSetups = create<SetupStore>((set, get) => {
  const hear = () => {
    if (get().stopListening) return;
    const stopListening = window.infinitary.events.on((event) => {
      if (event.type !== "device_setup" || event.doing !== "add") return;
      set({
        adding: get().adding.map((mac) =>
          mac.address !== event.address
            ? mac
            : {
                ...mac,
                ...(event.stage === "setting-up" || event.stage === "finding"
                  ? { stage: event.stage }
                  : {}),
                ...(event.stage === "finding" && event.deviceId
                  ? { deviceId: event.deviceId }
                  : {}),
                ...(event.name ? { name: event.name } : {}),
                ...(event.copy ? { copy: event.copy } : {}),
              },
        ),
      });
    });
    set({ stopListening });
  };
  const quiet = () => {
    const { adding, updating, stopListening } = get();
    if (adding.length > 0 || updating.length > 0) return;
    stopListening?.();
    set({ stopListening: null });
  };
  return {
    adding: [],
    updating: [],
    moving: [],
    stopListening: null,
    addFrom: (address, stage = "reaching") => {
      hear();
      set({ adding: [...get().adding, { address, stage }] });
    },
    addDone: (address) => {
      set({ adding: get().adding.filter((mac) => mac.address !== address) });
      quiet();
    },
    updateFrom: (deviceId) => set({ updating: [...get().updating, deviceId] }),
    updateDone: (deviceId) => {
      set({ updating: get().updating.filter((id) => id !== deviceId) });
      quiet();
    },
    moveFrom: (moving) => set({ moving: [...get().moving, moving] }),
    moveDone: (deviceId) =>
      set({ moving: get().moving.filter((each) => each.deviceId !== deviceId) }),
  };
});

/** "9:41": the minutes and seconds a link has left. */
export function linkTimeLeft(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "today 14:06", "yesterday 09:12" or "Oct 1 18:40": when a device joined. */
export function joinedWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  if (date.toDateString() === day.toDateString()) return `today ${time}`;
  day.setDate(day.getDate() - 1);
  if (date.toDateString() === day.toDateString()) return `yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** "14:02" today, otherwise "Oct 1 14:02": since when a device is out of reach. */
function sinceWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Whether a device answers now, or since when it has not. */
function seenWords(device: DeviceView, now: number): string {
  if (device.removal === "when-back")
    return device.otherVersion
      ? SEEN_WORDS.removedOnceUpdated
      : deviceConnecting(device)
        ? SEEN_WORDS.removedWhenBackConnecting
        : SEEN_WORDS.removedWhenBack;
  // On another version it is connected, whether or not it takes work.
  if (device.inReach || device.otherVersion) return SEEN_WORDS.now;
  if (device.restartedSince) return SEEN_WORDS.restarted;
  return device.seenAt === undefined
    ? SEEN_WORDS.outOfReach
    : `${SEEN_WORDS.since} ${sinceWhen(device.seenAt, now)}`;
}

/** The mono line under a device's name: what it is, when it joined, and when it was last seen. */
export function deviceDetail(device: DeviceView, now: number): string {
  // Reached over this Mac's own SSH, it is named by its address and that connection.
  if (device.remoteLogin && device.ssh) {
    const what = device.onThisMac && device.user ? `another user on ${HERE.this}` : aDevice(device);
    const where =
      device.removal === "when-back" || device.ssh.state === "stopped"
        ? seenWords(device, now)
        : sshConnectionWords.detail(device.ssh, device);
    return `${what} · ${device.remoteLogin} · ${where}`;
  }
  if (device.onThisMac && device.user) {
    const who = userDisplayName(device.user);
    return `another user on ${HERE.this} · runs work only, while ${who} is logged in · ${seenWords(device, now)}`;
  }
  // A Mac added by its address is named by it (components/devices/DevicesTab).
  if (device.remoteLogin)
    return `${aDevice(device)} · ${device.remoteLogin} · ${seenWords(device, now)}`;
  const reached =
    device.reachedOn === "local"
      ? WAYS_WORDS.reachedLocal
      : device.reachedOn === "private"
        ? WAYS_WORDS.reachedPrivate
        : null;
  return `${aDevice(device)} · joined ${joinedWhen(device.pairedAt, now)}${reached ? ` · ${reached}` : ""} · ${seenWords(device, now)}`;
}

/** The names of what a computer is signed in to: its subscriptions, then where projects live. */
function signedInNames(signIns: DeviceSignIns | undefined): string[] | null {
  if (!signIns?.signIns) return null;
  const names = signIns.signIns.accounts.map(
    (account) => catalogEntry(account.providerId)?.name ?? account.providerId,
  );
  for (const forge of signIns.signIns.forges?.signIns ?? []) names.push(forge.name);
  return [...new Set(names)];
}

/**
 * What a computer that runs work runs and is signed in to, or where its
 * removal stands: "Runs website and api · Signed in to Codex and GitHub".
 * A Mac that controls this Firstmate leads with "Controlling your Firstmate
 * now" while Firstmate is open on it; one that only controls says nothing
 * else (design skill `components/devices/DevicesTab`).
 */
export function deviceSummary(device: DeviceView, signIns: DeviceSignIns | undefined): string {
  const controlling = device.controlling ? [CONTROLLING_NOW] : [];
  if (!deviceRunsWork(device.kind)) return controlling.join("");
  const runs = device.runs ?? [];
  if (device.removal === "bringing-work")
    return runs.length > 0
      ? `Bringing ${namesInWords(runs)}'s unmerged work here…`
      : "Bringing its unmerged work here…";
  if (device.removal === "cleaning-up")
    return `Removing what Infinitary set up ${signInPlace({ ...device, onThisMac: device.onThisMac ?? false }).where}…`;
  const parts = [...controlling, runs.length > 0 ? `Runs ${namesInWords(runs)}` : RUNS_NO_PROJECT];
  const names = signedInNames(signIns);
  if (names)
    parts.push(names.length > 0 ? `Signed in to ${namesInWords(names)}` : "No sign-ins yet");
  return parts.join(" · ");
}

/**
 * The mono state on a computer's right: its tasks, idle, no new work,
 * connecting, or out of reach. A computer whose connection is still being
 * made, such as one just updated, is connecting; out of reach is for one
 * whose connection stopped, failed or dropped.
 */
export function deviceState(device: DeviceView): { text: string; tone: "busy" | "idle" | "warn" } {
  if (device.otherVersion?.takesWork === false) return { text: NO_NEW_WORK, tone: "warn" };
  if (!device.inReach) {
    const connecting = deviceConnecting(device);
    return { text: awayWord(connecting), tone: connecting ? "idle" : "warn" };
  }
  const tasks = device.tasks ?? 0;
  if (tasks > 0) return { text: tasks === 1 ? "1 task" : `${tasks} tasks`, tone: "busy" };
  return { text: "idle", tone: "idle" };
}

/**
 * The line under an out-of-reach computer's summary once this Mac's address
 * changed since it was last in reach, saying how it comes back; null
 * otherwise (design skill `components/devices/DevicesTab`, "Bringing a
 * computer back").
 */
export function strandedLine(device: DeviceView): string | null {
  // Connected on another version, it is not out of reach.
  if (
    !deviceRunsWork(device.kind) ||
    device.inReach ||
    device.otherVersion ||
    !device.addressChanged
  )
    return null;
  const said = `It still looks for ${HERE.this} at its old address.`;
  // Reached over this Mac's own SSH, it follows this Mac wherever it listens.
  if (device.remoteLogin) return null;
  if (device.onThisMac && device.user)
    return `${said} A new command run as ${userDisplayName(device.user)} brings it back.`;
  return `${said} A new command run there brings it back.`;
}

/**
 * The way back for an out-of-reach computer added by a command, once this
 * Mac's address changed: a new command. One added by its address comes back
 * by itself over this Mac's own SSH, or by Try again.
 */
export function wayBack(device: DeviceView): { label: string; does: DeviceMake } | null {
  if (!deviceRunsWork(device.kind) || device.inReach || device.otherVersion) return null;
  if (device.remoteLogin || !device.addressChanged) return null;
  return { label: "Make a command", does: device.onThisMac ? "user-command" : "command" };
}

/**
 * Why a computer a command added on another Mac has not reached this Mac
 * since it joined, under its summary, while macOS there holds its dial on
 * the local network; null otherwise (design skill
 * `components/devices/DevicesTab`, "Held on the local network"). Its way
 * back is Add it by its address.
 */
export function heldLine(device: DeviceView): string | null {
  if (!deviceRunsWork(device.kind) || device.inReach || device.otherVersion) return null;
  if (!device.heldOnLocalNetwork) return null;
  return [
    `It has not reached ${HERE.this} since it joined.`,
    `macOS lets Infinitary on ${deviceLabel(device)} use your local network only once someone there allows it.`,
    `Added by its address, ${HERE.this} reaches it with your SSH key instead.`,
  ].join(" ");
}

/**
 * Why this Mac stopped trying its SSH connection to a computer, and what to
 * do, under its summary in `--warn`; null while it connects or tries again
 * by itself.
 */
export function sshStoppedLine(device: DeviceView): string | null {
  if (device.ssh?.state !== "stopped" || !device.ssh.reason || !device.remoteLogin) return null;
  return sshConnectionWords
    .stopped(device.ssh.reason, { address: device.remoteLogin, device })
    .join(" ");
}

/** What a device that just joined can do, as the panel and the feed say it. */
export function joinedLine(name: string, kind: DeviceView["kind"]): string {
  return deviceJoinedLine({ name, kind });
}

const plusIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/**
 * The tab: on a Mac that controls another, which Mac and Leave
 * (`ControllingTab`); on the Mac where Firstmate lives, its devices.
 */
export function DevicesTab() {
  const thisMac = useShellStore((s) => s.thisMac);
  if (isView(thisMac)) return <ControllingTab mac={thisMac} />;
  return <HomeDevicesTab />;
}

type Busy = "link" | "remove" | "address" | null;

/** What an add by its address carries beyond the address: each the captain's own answer. */
type AddWith = { leave?: boolean; confirm?: string; password?: string };

function HomeDevicesTab() {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [signIns, setSignIns] = useState<DeviceSignIns[]>([]);
  const [addresses, setAddresses] = useState<DeviceAddresses | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [askingAddress, setAskingAddress] = useState(false);
  /** The address in By its address, kept across a refusal so it is not retyped. */
  const [addressDraft, setAddressDraft] = useState("");
  /** The refusal's lines, in that aside. Null until a try is refused. */
  const [addressRefusal, setAddressRefusal] = useState<readonly string[] | null>(null);
  /** A Cancel during a try ignores that try's refusal, so it does not reopen the aside. */
  const addressTry = useRef(0);
  /** Macs nearby with Remote Login on, looked for while By its address is open. */
  const [nearby, setNearby] = useState<NearbyMacsView>(NEARBY_OFF);
  /** How many pushes of Macs nearby this tab has heard, so an ask's older answer never covers a newer push. */
  const nearbyPushes = useRef(0);
  const [leaving, setLeaving] = useState<RemoteLoginLeaveQuestion | null>(null);
  /** The check line, shown before anything is sent. */
  const [confirming, setConfirming] = useState<RemoteLoginConfirmQuestion | null>(null);
  /** That user's password, asked once; the field itself keeps what is typed. */
  const [passwording, setPasswording] = useState<RemoteLoginPasswordQuestion | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { panel, show, clear } = usePanel();
  // The joined note says "no sign-ins yet" until that Mac has one, even if the
  // sign-in event was missed while this tab was closed.
  useEffect(() => {
    if (joinedNoticeClears(panel, signIns)) clear();
  }, [panel, signIns, clear]);
  const { adding, updating, moving } = useSetups();
  const arrival = useShellStore((s) => s.pendingDeviceArrival);
  const phone = useShellStore((s) => s.phoneShown);

  const refresh = useCallback(() => {
    void window.infinitary.devices.list().then(setDevices, () => undefined);
  }, []);

  useEffect(() => {
    refresh();
    void window.infinitary.devices.addresses().then(setAddresses, () => undefined);
    void window.infinitary.devices.signIns().then(setSignIns, () => undefined);
    const offDevices = window.infinitary.devices.onDevices(setDevices);
    // This Mac's network moves while the tab is open, and the row follows.
    const offAddresses = window.infinitary.devices.onAddresses(setAddresses);
    const offSignIns = window.infinitary.devices.onSignIns(setSignIns);
    const offNearby = window.infinitary.devices.onNearby((view) => {
      nearbyPushes.current += 1;
      setNearby(view);
    });
    return () => {
      offDevices();
      offAddresses();
      offSignIns();
      offNearby();
    };
  }, [refresh]);

  // Macs nearby (docs/devices.md, "Macs nearby"): looked for while By its
  // address is open, asked again inside the core's minute, and stopped
  // once it closes.
  useEffect(() => {
    if (!askingAddress) return;
    let open = true;
    const ask = () => {
      const pushes = nearbyPushes.current;
      void window.infinitary.devices.nearby(true).then(
        (view) => {
          // Every change is pushed in order, so once a push arrives after asking, the pushes carry this answer or newer.
          if (open && nearbyPushes.current === pushes) setNearby(view);
        },
        () => undefined,
      );
    };
    ask();
    const renew = setInterval(ask, NEARBY_RENEW_MS);
    return () => {
      open = false;
      clearInterval(renew);
      setNearby(NEARBY_OFF);
      void window.infinitary.devices.nearby(false).catch(() => undefined);
    };
  }, [askingAddress]);

  // The countdown ticks while a link is open; the seen times each minute.
  useEffect(() => {
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), panel?.state === "open" ? 1000 : 60_000);
    return () => clearInterval(tick);
  }, [panel]);

  const make = useCallback(
    async (what: DevicePanelMake, copy = false) => {
      setProblem(null);
      setChoosing(false);
      setBusy("link");
      try {
        // One link or command in the panel at a time: a new one closes the one it replaces.
        const open = usePanel.getState().panel;
        if (open?.state === "open") await window.infinitary.devices.stop(open.invite.id);
        const invite = await window.infinitary.devices.invite(
          what === "link" || what === "phone"
            ? { kind: "mac" }
            : what === "command"
              ? { kind: "mac", command: "another-mac" }
              : { kind: "work", command: "another-user" },
        );
        if (copy) {
          try {
            await navigator.clipboard.writeText(invite.command?.text ?? invite.link);
          } catch {
            // The panel still holds it, so the person can copy it there.
          }
        }
        show(invite, what, copy);
      } catch (caught) {
        setProblem(caught instanceof Error ? caught.message : "Could not make it.");
      } finally {
        setBusy(null);
      }
    },
    [show],
  );

  const copyWay = async (what: "link" | "command") => {
    await make(what, true);
  };

  const remove = useCallback(
    async (deviceId: string, when?: DeviceRemoveWhen) => {
      setProblem(null);
      setBusy("remove");
      setRemoving(null);
      try {
        await window.infinitary.devices.remove(deviceId, when);
      } catch (caught) {
        setProblem(caught instanceof Error ? caught.message : "Could not remove this device.");
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh],
  );

  // Adding a Mac by its address: the row follows each step. A refusal
  // keeps the address in the field and says its two lines in that aside.
  // Try again is the captain's own click. A Mac whose user runs another
  // Firstmate's work asks once; `leave` is the yes. A Mac that did not let
  // the captain's key in asks for that user's password, which goes on this
  // one call and is kept nowhere here.
  const addAt = useCallback(async (address: string, with_: AddWith = {}) => {
    const { leave, confirm, password } = with_;
    setProblem(null);
    setChoosing(false);
    setChanging(null);
    setLeaving(null);
    setConfirming(null);
    setPasswording(null);
    const setups = useSetups.getState();
    if (setups.adding.some((mac) => mac.address === address)) return;
    const mine = ++addressTry.current;
    setAddressRefusal(null);
    // The reaching row says a key is in use. It waits until the captain has
    // said this is the Mac, which is the call that carries `confirm`. The
    // call that carries the password is the one that lets Firstmate's key in.
    if (password) setups.addFrom(address, "letting-in");
    else if (confirm) setups.addFrom(address);
    try {
      const answer = await window.infinitary.devices.add(address, {
        ...(leave ? { leave: true as const } : {}),
        ...(confirm ? { confirm } : {}),
        ...(password ? { password } : {}),
      });
      if (mine !== addressTry.current) return;
      if ("asks" in answer && answer.asks === "confirm") {
        setAddressDraft(address);
        setAskingAddress(false);
        setConfirming(answer);
        return;
      }
      if ("asks" in answer && answer.asks === "password") {
        setAddressDraft(address);
        setAskingAddress(false);
        setPasswording(answer);
        return;
      }
      if ("asks" in answer) {
        setAskingAddress(false);
        setLeaving(answer);
        return;
      }
      setAskingAddress(false);
      setAddressDraft("");
      setAddressRefusal(null);
    } catch (caught) {
      if (mine !== addressTry.current) return;
      const message =
        caught instanceof Error ? caught.message : `Could not add this ${COMPUTER.one}.`;
      const lines = remoteLoginRefusalLines(message);
      setAddressDraft(address);
      setAddressRefusal(lines.length > 0 ? lines : [`Could not add this ${COMPUTER.one}.`]);
      setAskingAddress(true);
    } finally {
      useSetups.getState().addDone(address);
    }
  }, []);

  const update = useCallback(async (deviceId: string, password?: string) => {
    setProblem(null);
    setPasswording(null);
    const setups = useSetups.getState();
    if (setups.updating.includes(deviceId)) return;
    setups.updateFrom(deviceId);
    try {
      const answer = await window.infinitary.devices.update(
        deviceId,
        password ? { password } : undefined,
      );
      if ("asks" in answer && answer.asks === "password") {
        setPasswording(answer);
        return;
      }
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "Could not update Infinitary there.");
    } finally {
      useSetups.getState().updateDone(deviceId);
    }
  }, []);

  // Try again: this Mac's own SSH connection to it, tried once now.
  const tryAgain = useCallback(async (deviceId: string) => {
    setProblem(null);
    try {
      await window.infinitary.devices.tryAgain(deviceId);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "Could not try again.");
    }
  }, []);

  // Change address: its row says where this Mac looks; a refusal is said here too.
  const changeAddress = useCallback(async (deviceId: string, address: string) => {
    setProblem(null);
    setChanging(null);
    const setups = useSetups.getState();
    if (setups.moving.some((each) => each.deviceId === deviceId)) return;
    setups.moveFrom({ deviceId, address });
    try {
      await window.infinitary.devices.changeAddress(deviceId, address);
    } catch (caught) {
      setProblem(
        caught instanceof Error
          ? caught.message
          : `Could not change where this ${COMPUTER.one} is reached.`,
      );
    } finally {
      useSetups.getState().moveDone(deviceId);
    }
  }, []);

  const keep = useCallback(
    async (deviceId: string) => {
      setProblem(null);
      try {
        await window.infinitary.devices.keep(deviceId);
      } catch (caught) {
        setProblem(caught instanceof Error ? caught.message : "Could not keep this device.");
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  // A card's button lands here with what to do: make a link or a command,
  // add a Mac at an address, update Firstmate on one, or remove a device.
  // The click was the captain's own; this only carries it out - but a
  // computer out of reach asks how first.
  useEffect(() => {
    if (!arrival) return;
    useShellStore.getState().clearPendingDeviceArrival();
    if ("make" in arrival) {
      void make(arrival.make);
      return;
    }
    if ("add" in arrival) {
      void addAt(arrival.add);
      return;
    }
    if ("update" in arrival) {
      void update(arrival.update);
      return;
    }
    const gone = arrival.remove;
    void window.infinitary.devices.list().then(
      (listed) => {
        setDevices(listed);
        const device = listed.find((entry) => entry.id === gone);
        if (device && deviceRunsWork(device.kind) && !device.inReach) setRemoving(device.id);
        else void remove(gone);
      },
      () => undefined,
    );
  }, [arrival, make, remove, addAt, update]);

  const stop = async () => {
    const open = usePanel.getState().panel;
    clear();
    if (open?.state === "open")
      await window.infinitary.devices.stop(open.invite.id).catch(() => {});
  };

  const chooseAddress = async (address: string) => {
    setProblem(null);
    setBusy("address");
    try {
      setAddresses(await window.infinitary.devices.setAddress(address));
    } catch (caught) {
      setProblem(
        caught instanceof Error
          ? caught.message
          : `Could not change where devices find ${HERE.this}.`,
      );
    } finally {
      setBusy(null);
    }
  };

  // A link past its ten minutes reads as expired, whether or not the tab
  // was open when it ran out.
  const shown: LinkPanel | null =
    panel?.state === "open" && panel.invite.expiresAt <= now
      ? { state: "expired", make: panel.make }
      : panel;

  return (
    <DevicesTabView
      devices={devices}
      phone={phone}
      signIns={signIns}
      addresses={addresses}
      panel={shown}
      now={now}
      removing={removing}
      changing={changing}
      moving={moving}
      choosing={choosing}
      askingAddress={askingAddress}
      nearby={nearby}
      confirming={confirming}
      passwording={passwording}
      leaving={leaving}
      adding={adding}
      updating={updating}
      busy={busy}
      problem={problem}
      onAddMac={() => {
        addressTry.current += 1;
        setAskingAddress(false);
        setAddressRefusal(null);
        setLeaving(null);
        setConfirming(null);
        setPasswording(null);
        setChoosing(true);
      }}
      onCancelChoose={() => setChoosing(false)}
      addressDraft={addressDraft}
      addressRefusal={addressRefusal}
      onAddressDraft={setAddressDraft}
      onAskAddress={() => {
        setChoosing(false);
        setAddressDraft("");
        setAddressRefusal(null);
        setAskingAddress(true);
      }}
      onCancelAddress={() => {
        addressTry.current += 1;
        setAskingAddress(false);
        setConfirming(null);
        setPasswording(null);
        setAddressRefusal(null);
      }}
      onAddAt={(address) => void addAt(address)}
      onConfirm={(question) => void addAt(question.address, { confirm: question.line })}
      onCancelConfirm={() => {
        addressTry.current += 1;
        setConfirming(null);
        setAskingAddress(true);
      }}
      onPassword={(question, password) => {
        if (question.for === "update" && question.deviceId)
          void update(question.deviceId, password);
        else void addAt(question.address, { password });
      }}
      onCancelPassword={() => {
        addressTry.current += 1;
        const updating = passwording?.for === "update";
        setPasswording(null);
        if (!updating) setAskingAddress(true);
      }}
      onLeaveAndAdd={(address) => void addAt(address, { leave: true })}
      onCancelLeave={() => setLeaving(null)}
      onMake={(what) => void make(what)}
      onStop={() => void stop()}
      onDone={clear}
      onAskRemove={setRemoving}
      onUpdate={(device) => {
        // One too old to update from here gets the command to run there.
        if (device.otherVersion?.updateBy === "command")
          void make(device.onThisMac && device.user ? "user-command" : "command");
        else void update(device.id);
      }}
      onRemove={(id, when) => void remove(id, when)}
      onKeep={(id) => void keep(id)}
      onTryAgain={(id) => void tryAgain(id)}
      onAskChangeAddress={setChanging}
      onChangeAddress={(id, address) => void changeAddress(id, address)}
      onChooseAddress={(address) => void chooseAddress(address)}
      onCopyWay={(what) => void copyWay(what)}
    />
  );
}

export type DevicesTabViewProps = {
  devices: DeviceView[];
  /** Whether + A phone is offered (`phone` on `inf:devices:shown`; every build offers it). */
  phone: boolean;
  /** What each computer that runs work last said of its sign-ins. */
  signIns: DeviceSignIns[];
  addresses: DeviceAddresses | null;
  panel: LinkPanel | null;
  now: number;
  /** The device whose Remove question is open. */
  removing: string | null;
  /**
   * The computer whose address question is open: Change address, or Add it
   * by its address for one held on the local network.
   */
  changing: string | null;
  /** Computers whose address is changing. */
  moving: MovingMac[];
  /** + A Mac's question, how to add it, is open. */
  choosing: boolean;
  /** The question for the other Mac's address is open. */
  askingAddress: boolean;
  /** Macs nearby with Remote Login on, while that question is open. */
  nearby: NearbyMacsView;
  /** The check line, while the captain has not said this is the Mac. */
  confirming: RemoteLoginConfirmQuestion | null;
  /** That user's password, asked once, while the Mac did not let the captain's key in. */
  passwording: RemoteLoginPasswordQuestion | null;
  /** What the address field holds, kept after a refusal. */
  addressDraft: string;
  /** The refusal's lines in that aside, or null while none is showing. */
  addressRefusal: readonly string[] | null;
  onAddressDraft: (address: string) => void;
  /** Add it's question for a Mac whose user runs another Firstmate's work, while open. */
  leaving: RemoteLoginLeaveQuestion | null;
  /** Macs this Mac is adding by their address. */
  adding: AddingMac[];
  /** Computers whose Firstmate is updating, by id. */
  updating: string[];
  busy: Busy;
  problem: string | null;
  onAddMac: () => void;
  onCancelChoose: () => void;
  onAskAddress: () => void;
  onCancelAddress: () => void;
  onAddAt: (address: string) => void;
  /** The captain's yes on the check line. */
  onConfirm: (question: RemoteLoginConfirmQuestion) => void;
  /** Cancel on the check line: the address stays, and nothing is sent. */
  onCancelConfirm: () => void;
  /** The password the captain typed, once, to let Firstmate's own key in there. */
  onPassword: (question: RemoteLoginPasswordQuestion, password: string) => void;
  /** Cancel on the password: the address stays, and nothing is sent. */
  onCancelPassword: () => void;
  /** The captain's yes: add the Mac, leaving the other Firstmate should it not answer. */
  onLeaveAndAdd: (address: string) => void;
  onCancelLeave: () => void;
  onMake: (what: DevicePanelMake) => void;
  onStop: () => void;
  onDone: () => void;
  onAskRemove: (deviceId: string | null) => void;
  /** Update on a computer on another version of Firstmate. */
  onUpdate: (device: DeviceView) => void;
  onRemove: (deviceId: string, when?: DeviceRemoveWhen) => void;
  onKeep: (deviceId: string) => void;
  /** Try again: this Mac's own SSH connection to a computer it stopped trying. */
  onTryAgain: (deviceId: string) => void;
  /** Opens a computer's address question, or closes it with null. */
  onAskChangeAddress: (deviceId: string | null) => void;
  onChangeAddress: (deviceId: string, address: string) => void;
  onChooseAddress: (address: string) => void;
  /** Copy a link or a command from the ways section: makes one, copies it, opens the panel. */
  onCopyWay: (what: "link" | "command") => void;
};

export function DevicesTabView(props: DevicesTabViewProps) {
  const { devices, addresses, busy, problem } = props;
  return (
    <div data-devices="">
      <LinkPanelView {...props} />
      {problem && (
        <div style={{ marginBottom: 16 }}>
          <SettingError error={problem} surface="devices" />
        </div>
      )}
      <SectionLabel>Your devices</SectionLabel>
      <div className="fm-devices-say">
        Your first mate lives on {HERE.this}. Its tasks and conversation stay here. From any{" "}
        {COMPUTER.one} you add you can control it, and any {COMPUTER.one} you add can run a
        project's work. Running as another user on {HERE.this} only runs work.{" "}
        {anotherUserHere(thisDesktop().mac ? "darwin" : "linux").readsHere}
      </div>
      <div className="fm-devices-box" data-devices-list="" style={{ marginBottom: SECTION_GAP }}>
        <div className="fm-devices-row" data-device-row="this-mac">
          <span className="fm-devices-dot" data-tone="ok" />
          <span className="fm-devices-text">
            <span className="fm-devices-name">{HERE.This}</span>
            <span className="fm-devices-detail">Your first mate lives here</span>
          </span>
        </div>
        {inListOrder(devices).map((device) =>
          props.removing === device.id ? (
            <RemoveQuestion key={device.id} device={device} {...props} />
          ) : props.changing === device.id && (device.remoteLogin || device.heldOnLocalNetwork) ? (
            <AddressChange key={device.id} device={device} {...props} />
          ) : (
            <DeviceRow key={device.id} device={device} {...props} />
          ),
        )}
        {props.adding
          .filter((mac) => !devices.some((device) => device.id === mac.deviceId))
          .map((mac) => (
            <AddingRow key={mac.address} mac={mac} />
          ))}
        <div className="fm-devices-foot">
          <span className="fm-devices-foot-label">Add</span>
          <button
            type="button"
            className="fm-connect-chip"
            data-device-add="mac"
            aria-expanded={props.choosing}
            disabled={busy === "link"}
            onClick={props.onAddMac}
          >
            {plusIcon}
            <span>A {COMPUTER.one}</span>
          </button>
          {props.phone && (
            <button
              type="button"
              className="fm-connect-chip"
              data-device-add="phone"
              disabled={busy === "link"}
              onClick={() => props.onMake("phone")}
            >
              {plusIcon}
              <span>A phone</span>
            </button>
          )}
          <button
            type="button"
            className="fm-connect-chip"
            data-device-add="user"
            disabled={busy === "link"}
            onClick={() => props.onMake("user-command")}
          >
            {plusIcon}
            <span>Running as another user</span>
          </button>
        </div>
        {props.choosing && <AddChooser {...props} />}
        {props.askingAddress && <AddressQuestion {...props} />}
        {props.confirming && <ConfirmQuestion question={props.confirming} {...props} />}
        {props.passwording && <PasswordQuestion question={props.passwording} {...props} />}
        {props.leaving && <LeaveQuestion question={props.leaving} {...props} />}
      </div>
      <WaysSection {...props} />
      {addresses?.firewall && !panelForAnotherComputer(props.panel) && (
        <FirewallLine firewall={addresses.firewall} under="address" />
      )}
    </div>
  );
}

/** Whether a link or command for another computer is open in the panel, which then says what the firewall may keep out. */
function panelForAnotherComputer(panel: LinkPanel | null): boolean {
  return panel?.state === "open" && panel.make !== "user-command";
}

/**
 * A Linux home's firewall that may keep its other computers out (design
 * skill `components/devices/DevicesTab`, "A Linux home's firewall"): two
 * lines in `--warn`, and the way to let them in.
 */
function FirewallLine({
  firewall,
  under = "panel",
}: {
  firewall: DeviceFirewall;
  under?: "panel" | "address";
}) {
  const { lines, way } = firewallWords(firewall);
  return (
    <div
      className="fm-devices-firewall"
      data-device-firewall={firewall.name}
      data-under={under}
      role="note"
    >
      <div className="fm-devices-firewall-say">{lines.join(" ")}</div>
      <code className="fm-devices-firewall-way">{way}</code>
    </div>
  );
}

/**
 * The list's order (design skill `components/devices/DevicesTab`): another
 * user on this Mac right after This Mac, then each Mac in the order it joined.
 */
export function inListOrder(devices: readonly DeviceView[]): DeviceView[] {
  const here = (device: DeviceView) => deviceRunsWork(device.kind) && device.onThisMac === true;
  return [...devices.filter(here), ...devices.filter((device) => !here(device))];
}

/**
 * + A Mac's question: a link for a Mac its person sits at, a command for one
 * with no screen, or its address, to set it up from here over Remote Login.
 */
function AddChooser({ busy, onMake, onCancelChoose, onAskAddress }: DevicesTabViewProps) {
  return (
    <div className="fm-devices-aside" data-device-chooser="">
      <div className="fm-devices-question">How do you want to add it?</div>
      <div className="fm-devices-aside-say">
        Each way adds the same kind of {COMPUTER.one}. Pick the one that suits it.
      </div>
      <div className="fm-devices-aside-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake("link")}
        >
          Paste a link into Infinitary there
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake("command")}
        >
          Run a command there
        </Button>
        <Button variant="secondary" size="sm" disabled={busy === "link"} onClick={onAskAddress}>
          By its address
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancelChoose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * By its address (design skill `components/devices/DevicesTab`): the one
 * thing the captain supplies, the address he uses with SSH. Macs nearby
 * stand under it; picking one fills the field with your user name selected,
 * to change before Add it, and ↓ in the field reaches them.
 */
function AddressQuestion({
  addressDraft,
  addressRefusal,
  adding,
  nearby,
  devices,
  onAddressDraft,
  onAddAt,
  onCancelAddress,
}: DevicesTabViewProps) {
  const typed = addressDraft.trim();
  const trying = adding.some((mac) => mac.address === typed);
  const form = useRef<HTMLFormElement>(null);
  const field = () => form.current?.querySelector<HTMLInputElement>("#device-remote-login");
  // The address a pick just filled in, and how much of it is the user name:
  // once the field holds it, the caret goes there with the user name selected.
  const [picked, setPicked] = useState<{ address: string; user: number } | null>(null);
  useEffect(() => {
    if (!picked) return;
    const at = form.current?.querySelector<HTMLInputElement>("#device-remote-login");
    if (at && at.value === picked.address) {
      focusWithRing(at);
      at.setSelectionRange(0, picked.user);
    }
    setPicked(null);
  }, [picked]);
  return (
    <form
      ref={form}
      className="fm-devices-aside"
      data-device-address-question=""
      onSubmit={(event) => {
        event.preventDefault();
        if (typed && !trying) onAddAt(typed);
      }}
    >
      <label className="fm-devices-question" htmlFor="device-remote-login">
        The other {COMPUTER.one}'s address
      </label>
      <div className="fm-devices-aside-say">The one you use with SSH. {sshMustBeOn()}</div>
      {addressRefusal && (
        <div role="alert">
          {addressRefusal.map((line) => (
            <div
              key={line}
              className="fm-devices-aside-say"
              data-tone="warn"
              data-device-address-refusal=""
            >
              {line}
            </div>
          ))}
        </div>
      )}
      <div className="fm-devices-aside-actions">
        <Input
          id="device-remote-login"
          mono
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="you@mini.local"
          value={addressDraft}
          onChange={(event) => onAddressDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            const first = form.current?.querySelector<HTMLElement>(
              "[data-device-nearby-mac][tabindex='0']",
            );
            if (!first) return;
            event.preventDefault();
            focusWithRing(first);
          }}
          style={{ flex: 1, minWidth: 220, width: "auto" }}
        />
        <Button type="submit" size="sm" disabled={!typed || trying}>
          {addressRefusal ? "Try again" : "Add it"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancelAddress}>
          Cancel
        </Button>
      </div>
      <NearbyList
        nearby={nearby}
        devices={devices}
        onPick={(address) => {
          onAddressDraft(address);
          setPicked({
            address,
            user: nearby.user && address.includes("@") ? nearby.user.length : 0,
          });
        }}
        onLeave={() => {
          const at = field();
          if (at) focusWithRing(at);
        }}
      />
    </form>
  );
}

/**
 * Where an arrow, Home or End moves among `count` rows from `at`, as lists
 * do on a Mac: no wrapping, and -1 for ↑ from the first row, which leaves
 * the list for the field above it; null for a key that moves nothing.
 */
export function nearbyStep(key: string, at: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(at + 1, count - 1);
    case "ArrowUp":
      return at - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * What must be on at the other computer to reach it by its address: a Mac's
 * Remote Login, as a Mac home has always said; a Linux home, where the other
 * computer is as likely Linux, names both.
 */
function sshMustBeOn(): string {
  return thisDesktop().mac
    ? "Remote Login must be on there."
    : "Its SSH server, or Remote Login on a Mac, must be on.";
}

/**
 * Macs nearby with Remote Login on (design skill AddAMac, "Nearby"): each
 * by its own name, drawn as text, and the address it fills in; one already
 * on Your devices is marked. The list is one Tab stop and the arrows move
 * through it. While none answered it says it is looking; when macOS has not
 * allowed the local network, or the looking stopped, it says so.
 */
function NearbyList({
  nearby,
  devices,
  onPick,
  onLeave,
}: {
  nearby: NearbyMacsView;
  devices: readonly DeviceView[];
  onPick: (address: string) => void;
  onLeave: () => void;
}) {
  const [stop, setStop] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  if (nearby.state === "off") return null;
  const macs = nearby.macs;
  const at = Math.min(stop, Math.max(macs.length - 1, 0));
  const [notAllowed, allowIt] = nearbyMacsWords.notAllowed;
  return (
    <div className="fm-devices-nearby" data-device-nearby={nearby.state}>
      <div className="fm-devices-nearby-label" id="device-nearby-label">
        {nearbyMacsWords.label}
      </div>
      {nearby.state === "not-allowed" && (
        <div role="status" data-device-nearby-not-allowed="">
          <div className="fm-devices-aside-say" data-tone="warn">
            {notAllowed}
          </div>
          <div className="fm-devices-aside-say">{allowIt}</div>
        </div>
      )}
      {nearby.state === "failed" && macs.length === 0 && (
        <div className="fm-devices-aside-say" role="status">
          {nearbyMacsWords.failed}
        </div>
      )}
      {nearby.state === "looking" && macs.length === 0 && (
        <div className="fm-devices-aside-say" data-device-nearby-looking="">
          {thisDesktop().mac ? nearbyMacsWords.looking : nearbyMacsWords.lookingSsh}
        </div>
      )}
      {macs.length > 0 && (
        <ul ref={list} className="fm-devices-nearby-list" aria-labelledby="device-nearby-label">
          {macs.map((mac, index) => {
            const address = nearbyAddress(mac, nearby.user);
            const onList = nearbyOnList(mac, devices);
            return (
              <li key={`${mac.at} ${mac.name}`}>
                <button
                  type="button"
                  className="fm-devices-nearby-row"
                  data-device-nearby-mac={mac.at}
                  tabIndex={index === at ? 0 : -1}
                  onFocus={() => setStop(index)}
                  onClick={() => onPick(address)}
                  onKeyDown={(event) => {
                    const next = nearbyStep(event.key, index, macs.length);
                    if (next === null) return;
                    event.preventDefault();
                    if (next < 0) {
                      onLeave();
                      return;
                    }
                    const row = list.current?.querySelectorAll<HTMLElement>(
                      "[data-device-nearby-mac]",
                    )[next];
                    if (row) focusWithRing(row);
                  }}
                >
                  <span className="fm-devices-nearby-name">{mac.name}</span>
                  <span className="fm-devices-nearby-address">{address}</span>
                  {onList && (
                    <span className="fm-devices-state" data-device-nearby-on-list="">
                      {nearbyMacsWords.onList}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The check line, before anything is sent (design skill AddAMac, "Your yes").
 * Cancel holds the focus so Enter never says this is the Mac.
 */
function ConfirmQuestion({
  question,
  onConfirm,
  onCancelConfirm,
}: DevicesTabViewProps & { question: RemoteLoginConfirmQuestion }) {
  const [found, compare] = remoteLoginWords.confirmQuestion(question.address);
  return (
    <div className="fm-devices-aside" data-device-confirm-question={question.address}>
      <div className="fm-devices-question">{found}</div>
      <div className="fm-devices-aside-say">{compare}</div>
      <div className="fm-devices-check" data-device-check-line="">
        {question.line}
      </div>
      <div className="fm-devices-aside-actions">
        <Button size="sm" onClick={() => onConfirm(question)}>
          This is the {COMPUTER.one}
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onCancelConfirm}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * That user's password, asked once when the Mac did not let the captain's
 * key in (design skill AddAMac, "The password, once"). The field holds what
 * is typed until Add it sends it on that one call, then empties; a wrong one
 * is said above an empty field. Enter adds it, and Cancel keeps the address.
 */
function PasswordQuestion({
  question,
  onPassword,
  onCancelPassword,
}: DevicesTabViewProps & { question: RemoteLoginPasswordQuestion }) {
  const [typed, setTyped] = useState("");
  const [found, say] =
    question.for === "update"
      ? remoteLoginWords.passwordUpdateQuestion(question.address)
      : question.for === "install"
        ? remoteLoginWords.passwordInstallQuestion(question.address)
        : remoteLoginWords.passwordQuestion(question.address);
  const field = remoteLoginWords.passwordField(question.user);
  const wrong = question.wrong
    ? remoteLoginWords.refused("password-wrong", { address: question.address })
    : null;
  return (
    <form
      className="fm-devices-aside"
      data-device-password-question={question.address}
      onSubmit={(event) => {
        event.preventDefault();
        if (!typed) return;
        const password = typed;
        setTyped("");
        onPassword(question, password);
      }}
    >
      <div className="fm-devices-question">{found}</div>
      <div className="fm-devices-aside-say">{say}</div>
      {wrong && (
        <div role="alert">
          {wrong.map((line) => (
            <div
              key={line}
              className="fm-devices-aside-say"
              data-tone="warn"
              data-device-password-refusal=""
            >
              {line}
            </div>
          ))}
        </div>
      )}
      <div className="fm-devices-aside-actions">
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label={field}
          placeholder={field}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          style={{ flex: 1, minWidth: 220, width: "auto" }}
        />
        <Button type="submit" size="sm" disabled={!typed}>
          {question.for === "update" ? "Update" : "Add it"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={onCancelPassword}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Add it's one question for a Mac whose user runs another Firstmate's work
 * (design skill `components/devices/AddAMac`, "Another first mate's Mac"),
 * with Cancel focused so Enter never leaves it.
 */
function LeaveQuestion({
  question,
  onLeaveAndAdd,
  onCancelLeave,
}: DevicesTabViewProps & { question: RemoteLoginLeaveQuestion }) {
  const [found, ...said] = remoteLoginWords.leaveQuestion(question);
  return (
    <div className="fm-devices-aside" data-device-leave-question={question.address}>
      <div className="fm-devices-question">{found}</div>
      {said.map((line) => (
        <div key={line} className="fm-devices-aside-say">
          {line}
        </div>
      ))}
      <div className="fm-devices-aside-actions">
        <Button variant="danger" size="sm" onClick={() => onLeaveAndAdd(question.address)}>
          Leave it and add
        </Button>
        <Button variant="ghost" size="sm" autoFocus onClick={onCancelLeave}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Where a Mac being added by its address stands, as its row says it: how far
 * the copy has gone once it is sent - the bytes sent so far, never a share of
 * a total - and before that the stage. `name` is how the row names it.
 */
function addingWords(mac: AddingMac, name: string): string {
  if (mac.copy?.state === "sending") return remoteLoginWords.sendingRow(name, mac.copy.sent ?? 0);
  if (mac.copy?.state === "starting") return remoteLoginWords.startingRow(name);
  switch (mac.stage) {
    case "setting-up":
      return remoteLoginWords.settingUpRow(name);
    case "finding":
      return remoteLoginWords.findingRow({ name });
    case "letting-in":
      return remoteLoginWords.lettingInRow(mac.address);
    default:
      return remoteLoginWords.reachingRow(mac.address);
  }
}

/** A Mac being added by its address: an idle dot, and where its setup stands. */
function AddingRow({ mac }: { mac: AddingMac }) {
  return (
    <div
      className="fm-devices-row"
      data-device-adding={mac.address}
      data-copy={mac.copy?.state}
      role="status"
    >
      <span className="fm-devices-dot" />
      <span className="fm-devices-text">
        <span className="fm-devices-name">{mac.name ?? mac.address}</span>
        <span className="fm-devices-detail">
          a {COMPUTER.one} · {mac.address}
        </span>
        <span className="fm-devices-summary">{addingWords(mac, mac.name ?? mac.address)}</span>
      </span>
    </div>
  );
}

function DeviceRow({
  device,
  signIns,
  now,
  updating,
  adding,
  busy,
  onAskRemove,
  onUpdate,
  onKeep,
  onMake,
  moving,
  onTryAgain,
  onAskChangeAddress,
}: DevicesTabViewProps & { device: DeviceView }) {
  const label = deviceLabel(device);
  if (!deviceRunsWork(device.kind)) {
    const summary = deviceSummary(device, undefined);
    return (
      <div
        className="fm-devices-row"
        data-device-row={device.id}
        data-controlling={device.controlling ? "" : undefined}
      >
        <span className="fm-devices-dot" data-tone={device.inReach ? "ok" : "warn"} />
        <span className="fm-devices-text">
          <span className="fm-devices-name">{device.name}</span>
          <span className="fm-devices-detail">{deviceDetail(device, now)}</span>
          {summary && <span className="fm-devices-summary">{summary}</span>}
        </span>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Remove ${label}`}
          onClick={() => onAskRemove(device.id)}
        >
          Remove
        </Button>
      </div>
    );
  }
  const state = deviceState(device);
  const own = signIns.find((entry) => entry.deviceId === device.id);
  const updatingHere = updating.includes(device.id);
  // Brought back over Remote Login: reached, then told where this Mac is now.
  const finding = adding.find((mac) => mac.deviceId === device.id);
  // Looked for at another address, to be reached there from now on.
  const moved = moving.find((each) => each.deviceId === device.id);
  const settling =
    device.removal === "bringing-work" ||
    device.removal === "cleaning-up" ||
    updatingHere ||
    finding !== undefined ||
    moved !== undefined;
  const stranded = settling ? null : strandedLine(device);
  const held = settling ? null : heldLine(device);
  const back = settling ? null : wayBack(device);
  const stopped = settling ? null : sshStoppedLine(device);
  // A Mac that left for another Firstmate is not coming back: Remove only.
  const left = runsForAnotherFirstmate(device.ssh);
  const other = device.otherVersion;
  return (
    <div
      className="fm-devices-row"
      data-device-row={device.id}
      data-controlling={device.controlling ? "" : undefined}
      data-removal={device.removal}
      data-other-version={other ? (other.takesWork ? "takes-work" : "no-work") : undefined}
    >
      <span
        className="fm-devices-dot"
        data-tone={
          device.inReach && other?.takesWork !== false
            ? "ok"
            : deviceConnecting(device)
              ? "idle"
              : "warn"
        }
      />
      <span className="fm-devices-text">
        <span className="fm-devices-name">{label}</span>
        <span className="fm-devices-detail">{deviceDetail(device, now)}</span>
        <span className="fm-devices-summary" role={finding || moved ? "status" : undefined}>
          {finding
            ? addingWords(finding, label)
            : moved
              ? remoteLoginWords.reachingRow(moved.address)
              : updatingHere
                ? remoteLoginWords.updatingRow(device)
                : deviceSummary(device, own)}
        </span>
        {stranded && (
          <span className="fm-devices-summary" data-device-stranded="">
            {stranded}
          </span>
        )}
        {held && (
          <span className="fm-devices-summary" data-device-held="">
            {held}
          </span>
        )}
        {stopped && (
          <span className="fm-devices-version" data-tone="warn" data-device-ssh-stopped="">
            {stopped}
          </span>
        )}
        {other && !updatingHere && (
          <span className="fm-devices-version" data-tone={other.takesWork ? undefined : "warn"}>
            {deviceWords.otherVersion(other)}
          </span>
        )}
      </span>
      {!settling && (
        <span className="fm-devices-state" data-tone={state.tone}>
          {state.text}
        </span>
      )}
      {back && (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake(back.does)}
        >
          {back.label}
        </Button>
      )}
      {held && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Add ${label} by its address`}
          onClick={() => onAskChangeAddress(device.id)}
        >
          Add it by its address
        </Button>
      )}
      {stopped && !left && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Try again to reach ${label}`}
          onClick={() => onTryAgain(device.id)}
        >
          Try again
        </Button>
      )}
      {device.ssh && device.remoteLogin && !settling && !left && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Change the address of ${label}`}
          onClick={() => onAskChangeAddress(device.id)}
        >
          Change address
        </Button>
      )}
      {other && !settling && device.removal !== "when-back" && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Update ${label}`}
          disabled={busy === "link"}
          onClick={() => onUpdate(device)}
        >
          Update
        </Button>
      )}
      {device.removal === "when-back" ? (
        <Button variant="ghost" size="sm" onClick={() => onKeep(device.id)}>
          Keep it
        </Button>
      ) : settling ? null : (
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Remove ${label}`}
          onClick={() => onAskRemove(device.id)}
        >
          Remove
        </Button>
      )}
    </div>
  );
}

/**
 * Change address's one question, in place of the row (design skill
 * `components/devices/DevicesTab`, "Reached over your SSH"): the address
 * the captain reaches that Mac at with SSH now, which this Mac checks is the
 * same computer before it uses it. For a Mac a command added that macOS
 * holds on the local network it is Add it by its address ("Held on the local
 * network"): the address the captain reaches it at with SSH, as the user it
 * runs work as, where this Mac finds it again as the same computer and
 * reaches it over its own SSH connection from then on.
 */
function AddressChange({
  device,
  onChangeAddress,
  onAddAt,
  onAskChangeAddress,
}: DevicesTabViewProps & { device: DeviceView }) {
  const adding = device.heldOnLocalNetwork === true;
  const [address, setAddress] = useState(device.remoteLogin ?? "");
  const typed = address.trim();
  const unchanged = !adding && typed === device.remoteLogin;
  const id = `device-address-${device.id}`;
  return (
    <form
      className="fm-devices-aside"
      data-device-address-change={device.id}
      data-adding={adding ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!typed || unchanged) return;
        if (adding) onAddAt(typed);
        else onChangeAddress(device.id, typed);
      }}
    >
      <label className="fm-devices-question" htmlFor={id}>
        {sshConnectionWords.changeAddress(device)}
      </label>
      <div className="fm-devices-aside-say">
        {!adding
          ? `The address you use with SSH for it now. ${HERE.This} checks it is the same ${COMPUTER.one} first.`
          : device.user
            ? `The address you use with SSH for it, as ${device.user}. ${sshMustBeOn()}`
            : `The address you use with SSH for it. ${sshMustBeOn()}`}
      </div>
      <div className="fm-devices-aside-actions">
        <Input
          id={id}
          mono
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={adding ? `${device.user ?? "you"}@mini.local` : "you@mini.local"}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          style={{ flex: 1, minWidth: 220, width: "auto" }}
        />
        <Button type="submit" size="sm" disabled={!typed || unchanged}>
          {adding ? "Add it" : "Change it"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={() => onAskChangeAddress(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Remove's one question, in place, with Keep it focused so Enter never
 * removes: a Mac that controls this Firstmate is cut off at once; a
 * computer that runs work brings its unmerged work here first; one out of
 * reach asks whether to wait for it or remove it now.
 */
function RemoveQuestion({
  device,
  busy,
  onAskRemove,
  onRemove,
}: DevicesTabViewProps & { device: DeviceView }) {
  const keep = (
    <Button
      variant="ghost"
      size="sm"
      autoFocus
      disabled={busy === "remove"}
      onClick={() => onAskRemove(null)}
    >
      Keep it
    </Button>
  );
  const lines = removeLines(device);
  return (
    <div className="fm-devices-row" data-device-removing={device.id}>
      <span className="fm-devices-dot" />
      <span className="fm-devices-text">
        {lines.map((line) => (
          <span key={line} className="fm-devices-question">
            {line}
          </span>
        ))}
      </span>
      {keep}
      {deviceRunsWork(device.kind) && !device.inReach ? (
        <>
          {/* One that runs work for another Firstmate now is not coming back. */}
          {!runsForAnotherFirstmate(device.ssh) && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === "remove"}
              onClick={() => onRemove(device.id, "when-back")}
            >
              {device.otherVersion ? "Remove once it is updated" : "Remove when it is back"}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={busy === "remove"}
            onClick={() => onRemove(device.id, "now")}
          >
            Remove now
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          size="sm"
          pending={busy === "remove"}
          pendingLabel="Removing..."
          onClick={() => onRemove(device.id)}
        >
          Remove
        </Button>
      )}
    </div>
  );
}

function wayState(count: number, on: boolean): { text: string; tone?: "busy" } {
  if (!on) return { text: WAYS_WORDS.off };
  if (count > 0) return { text: wayCount(count), tone: "busy" };
  return { text: WAYS_WORDS.ready };
}

function WaysSection({ addresses, devices, busy, onCopyWay }: DevicesTabViewProps) {
  if (!addresses) return null;
  const local = addresses.addresses.filter((entry) => entry.network === "local");
  const priv = addresses.addresses.filter((entry) => entry.network === "private");
  const none = local.length === 0 && priv.length === 0;
  return (
    <>
      <SectionLabel>{WAYS_WORDS.label}</SectionLabel>
      {none ? (
        <SettingRow
          id="device-address"
          title="Address"
          description={WAYS_WORDS.noNetwork}
          control={<span className="fm-devices-address">{HERE.this} only</span>}
        />
      ) : (
        <div className="fm-devices-box" data-device-ways="">
          <WayRow
            on={local.length > 0}
            title={WAYS_WORDS.local}
            detail={
              local.length > 0
                ? [
                    ...local.map((entry) => entry.address),
                    ...(addresses.name ? [addresses.name] : []),
                  ].join(" · ")
                : undefined
            }
            line={local.length > 0 ? WAYS_WORDS.localLine : WAYS_WORDS.localOff}
            state={wayState(
              devices.filter((device) => device.reachedOn === "local").length,
              local.length > 0,
            )}
            way="local"
          />
          <WayRow
            on={priv.length > 0}
            title={priv.length > 0 ? WAYS_WORDS.private : WAYS_WORDS.privateOffTitle}
            detail={priv.map((entry) => entry.address).join(" · ") || undefined}
            line={priv.length > 0 ? WAYS_WORDS.privateLine : WAYS_WORDS.privateOff}
            state={wayState(
              devices.filter((device) => device.reachedOn === "private").length,
              priv.length > 0,
            )}
            way="private"
          />
          <WayRow
            on={false}
            title={WAYS_WORDS.internet}
            line={WAYS_WORDS.internetLine}
            state={wayState(0, false)}
            way="internet"
          />
          <div className="fm-devices-ways-foot">
            <p>{WAYS_WORDS.foot}</p>
            <div className="fm-devices-ways-actions">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === "link"}
                onClick={() => onCopyWay("link")}
              >
                {WAYS_WORDS.copyLink}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === "link"}
                onClick={() => onCopyWay("command")}
              >
                {WAYS_WORDS.copyCommand}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function WayRow({
  on,
  title,
  detail,
  line,
  state,
  way,
}: {
  on: boolean;
  title: string;
  detail?: string;
  line: string;
  state: { text: string; tone?: "busy" };
  way: string;
}) {
  return (
    <div className="fm-devices-row" data-device-way={way} data-on={on ? "yes" : "no"}>
      <span className="fm-devices-dot" data-tone={on ? "ok" : undefined} />
      <span className="fm-devices-text">
        <span className="fm-devices-name">{title}</span>
        {detail && <span className="fm-devices-detail">{detail}</span>}
        <span className="fm-devices-summary">{line}</span>
      </span>
      <span className="fm-devices-state" data-tone={state.tone}>
        {state.text}
      </span>
    </div>
  );
}

function LinkPanelView({
  panel,
  now,
  busy,
  addresses,
  onStop,
  onDone,
  onMake,
}: DevicesTabViewProps) {
  if (!panel) return null;
  if (panel.state === "joined")
    return (
      <div className="fm-devices-panel" data-panel-state="joined" role="status">
        <span className="fm-devices-dot" data-tone="ok" />
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--fg-1)" }}>{panel.line}</div>
          {panel.work && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              Give it a project in Projects when you want it to run work.
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  if (panel.state === "expired")
    return (
      <div className="fm-devices-panel" data-panel-state="expired" role="status">
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--fg-1)" }}>
            The {PANEL_WORDS[panel.make].thing} expired before any{" "}
            {panel.make === "phone" ? "phone" : COMPUTER.one} used it.
          </div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            Make a new one when the {panel.make === "phone" ? "phone" : `other ${COMPUTER.one}`} is
            ready.
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake(panel.make)}
        >
          Make a new one
        </Button>
      </div>
    );
  return (
    <OpenLink
      key={panel.invite.id}
      invite={panel.invite}
      make={panel.make}
      now={now}
      startCopied={panel.copied === true}
      firewall={panelForAnotherComputer(panel) ? addresses?.firewall : undefined}
      onStop={onStop}
    />
  );
}

/** The open link or command: it on one line, Copy, the count and Stop it. */
function OpenLink({
  invite,
  make,
  now,
  firewall,
  startCopied,
  onStop,
}: {
  invite: DeviceInvite;
  make: DevicePanelMake;
  now: number;
  /** A Linux home's firewall that may keep the other computer out. */
  firewall: DeviceFirewall | undefined;
  /** The section's Copy button already copied it, so the panel opens reading Copied. */
  startCopied?: boolean;
  onStop: () => void;
}) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(startCopied ? "copied" : null);
  useEffect(() => {
    if (copied !== "copied") return;
    const reset = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(reset);
  }, [copied]);
  const words = PANEL_WORDS[make];
  const text = invite.command?.text ?? invite.link;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="fm-devices-panel" data-panel-state="open" data-panel-holds={words.thing}>
      <SectionLabel>{words.label}</SectionLabel>
      <div className="fm-devices-panel-say">{words.say.join(" ")}</div>
      {make === "phone" && <PhoneCode link={invite.link} />}
      {firewall && <FirewallLine firewall={firewall} />}
      <div className="fm-devices-panel-line">
        <code className="fm-devices-link" data-device-link="">
          {text}
        </code>
        <Button size="sm" onClick={() => void copy()}>
          {copied === "copied" ? "Copied" : words.copy}
        </Button>
      </div>
      <div className="fm-devices-panel-foot">
        <span className="fm-devices-count">
          works once · {linkTimeLeft(invite.expiresAt, now)} left
        </span>
        <Button variant="ghost" size="sm" onClick={onStop}>
          Stop it
        </Button>
      </div>
      {copied === "failed" && (
        <SettingError
          error={`Could not copy the ${words.thing}. Select it and copy it yourself.`}
        />
      )}
    </div>
  );
}
