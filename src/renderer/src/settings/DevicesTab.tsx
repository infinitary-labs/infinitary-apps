import { anotherUserHere, COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceAddresses,
  type DeviceRemoveWhen,
  type DeviceView,
  deviceRunsWork,
} from "@shared/devices";
import { NEARBY_OFF, NEARBY_RENEW_MS, type NearbyMacsView } from "@shared/nearbyMacs";
import {
  addressParts,
  type RemoteLoginConfirmQuestion,
  type RemoteLoginLeaveQuestion,
  type RemoteLoginPasswordQuestion,
  type RemoteLoginRefusedAnswer,
  remoteLoginRefusalLines,
} from "@shared/remoteLogin";
import type { DeviceSignIns } from "@shared/signIns";
import { useCallback, useEffect, useRef, useState } from "react";
import "../accounts/connectChips.css";
import { useShellStore } from "../app/store";
import { thisDesktop } from "../design/core/desktop";
import { useHereAs } from "../devices/useFirstMatePlace";
import { isView, updateThereWords } from "../devices/viewWords";
import { ControllingTab } from "./ControllingTab";
import { AddressChange, DeviceRow, RemoveQuestion } from "./DeviceRow";
import {
  AddChooser,
  AddingRow,
  AddressQuestion,
  ConfirmQuestion,
  LeaveQuestion,
  PasswordQuestion,
} from "./DevicesAdd";
import { FirewallLine, LinkPanelView, panelForAnotherComputer, WaysSection } from "./DevicesLinks";
import "./devices.css";
import {
  type Busy,
  type DevicesTabViewProps,
  joinedNoticeClears,
  type LinkPanel,
  type ReachRefusal,
  reachRefusalAfter,
  reachRefusalOf,
  usePanel,
  useSetups,
} from "./devicesState";
import type { DevicePanelMake } from "./devicesWords";
import { SECTION_GAP, SectionLabel, SettingError } from "./settingRows";

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
 *
 * Its parts each have their own file: the words and a row's lines
 * (`devicesWords.ts`), the stores and the props every part reads
 * (`devicesState.ts`), adding a computer (`DevicesAdd.tsx`), a device's row
 * and its questions (`DeviceRow.tsx`), the link panel and the ways
 * (`DevicesLinks.tsx`), and Macs nearby (`../devices/NearbyList.tsx`).
 */

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
 * The tab: the first mate's devices, and on a computer that controls it,
 * which computer and Leave above them (`ControllingTab`, docs/view.md,
 * "Settings on a view"). A first mate there too old to answer its devices
 * to a view says so in their place.
 */
export function DevicesTab() {
  const thisMac = useShellStore((s) => s.thisMac);
  if (!isView(thisMac)) return <HomeDevicesTab />;
  return (
    <>
      <ControllingTab mac={thisMac} />
      <div style={{ marginTop: SECTION_GAP }}>
        {thisMac.devicesNeedUpdateThere ? (
          <div className="fm-devices-say" data-devices-wait="">
            {updateThereWords(thisMac)}
          </div>
        ) : (
          <HomeDevicesTab />
        )}
      </div>
    </>
  );
}

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
  /** The port beside it, empty for SSH's own; kept the same way. */
  const [portDraft, setPortDraft] = useState("");
  /** Keeps an address in the two fields it was typed in. */
  const keepTyped = useCallback((address: string) => {
    const parts = addressParts(address);
    setAddressDraft(parts.address);
    setPortDraft(parts.port);
  }, []);
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
  /** The "could not reach" refusal in `problem`, with what it was about: that line goes when the computer answers again. */
  const [problemAbout, setProblemAbout] = useState<ReachRefusal | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { panel, show, clear } = usePanel();
  // The joined note says "no sign-ins yet" until that Mac has one, even if the
  // sign-in event was missed while this tab was closed.
  useEffect(() => {
    if (joinedNoticeClears(panel, signIns)) clear();
  }, [panel, signIns, clear]);
  const { adding, updating, moving, updateCopy } = useSetups();
  const arrival = useShellStore((s) => s.pendingDeviceArrival);

  useEffect(() => {
    if (!problemAbout) return;
    if (!reachRefusalAfter(problemAbout, devices)) return;
    setProblem((line) => (line === problemAbout.line ? null : line));
    setProblemAbout(null);
  }, [problemAbout, devices]);

  /** A refusal of an update or an address change, answered as data so a reach refusal is told from the rest. */
  const refused = useCallback(
    (deviceId: string, answer: RemoteLoginRefusedAnswer, address?: string) => {
      setProblem(answer.lines.join("\n"));
      setProblemAbout(reachRefusalOf(answer, deviceId, Date.now(), address));
    },
    [],
  );

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
            ? { kind: "mac", ...(what === "phone" ? { phone: true } : {}) }
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
  const addAt = useCallback(
    async (address: string, with_: AddWith = {}) => {
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
          keepTyped(address);
          setAskingAddress(false);
          setConfirming(answer);
          return;
        }
        if ("asks" in answer && answer.asks === "password") {
          keepTyped(address);
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
        setPortDraft("");
        setAddressRefusal(null);
      } catch (caught) {
        if (mine !== addressTry.current) return;
        const message =
          caught instanceof Error ? caught.message : `Could not add this ${COMPUTER.one}.`;
        const lines = remoteLoginRefusalLines(message);
        keepTyped(address);
        setAddressRefusal(lines.length > 0 ? lines : [`Could not add this ${COMPUTER.one}.`]);
        setAskingAddress(true);
      } finally {
        useSetups.getState().addDone(address);
      }
    },
    [keepTyped],
  );

  const update = useCallback(
    async (deviceId: string, password?: string) => {
      setProblem(null);
      setPasswording(null);
      const setups = useSetups.getState();
      if (setups.updating.includes(deviceId)) return;
      setups.updateFrom(deviceId);
      try {
        const answer = await window.infinitary.devices.update(deviceId, {
          ...(password ? { password } : {}),
        });
        if ("refused" in answer) {
          refused(deviceId, answer);
          return;
        }
        if ("asks" in answer && answer.asks === "password") {
          setPasswording(answer);
          return;
        }
      } catch (caught) {
        setProblem(caught instanceof Error ? caught.message : "Could not update Infinitary there.");
      } finally {
        useSetups.getState().updateDone(deviceId);
      }
    },
    [refused],
  );

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
  const changeAddress = useCallback(
    async (deviceId: string, address: string) => {
      setProblem(null);
      setChanging(null);
      const setups = useSetups.getState();
      if (setups.moving.some((each) => each.deviceId === deviceId)) return;
      setups.moveFrom({ deviceId, address });
      try {
        const answer = await window.infinitary.devices.changeAddress(deviceId, address);
        if ("refused" in answer) refused(deviceId, answer, address);
      } catch (caught) {
        setProblem(
          caught instanceof Error
            ? caught.message
            : `Could not change where this ${COMPUTER.one} is reached.`,
        );
      } finally {
        useSetups.getState().moveDone(deviceId);
      }
    },
    [refused],
  );

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

  // A link past its thirty minutes reads as expired, whether or not the tab
  // was open when it ran out.
  const shown: LinkPanel | null =
    panel?.state === "open" && panel.invite.expiresAt <= now
      ? { state: "expired", make: panel.make }
      : panel;

  return (
    <DevicesTabView
      devices={devices}
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
      updateCopy={updateCopy}
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
      portDraft={portDraft}
      addressRefusal={addressRefusal}
      onAddressDraft={setAddressDraft}
      onPortDraft={setPortDraft}
      onAskAddress={() => {
        setChoosing(false);
        setAddressDraft("");
        setPortDraft("");
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
      onCopyWay={(what) => void make(what, true)}
    />
  );
}

export function DevicesTabView(props: DevicesTabViewProps) {
  const { devices, addresses, busy, problem } = props;
  const here = useHereAs();
  const fromAView = useShellStore((s) => isView(s.thisMac));
  return (
    <div data-devices="">
      <LinkPanelView {...props} />
      {problem && (
        <div style={{ marginBottom: 16 }}>
          <SettingError error={here(problem)} surface="devices" />
        </div>
      )}
      <SectionLabel>Your devices</SectionLabel>
      <div className="fm-devices-say">{here(devicesIntro(fromAView))}</div>
      <div className="fm-devices-box" data-devices-list="" style={{ marginBottom: SECTION_GAP }}>
        <div className="fm-devices-row" data-device-row="this-mac">
          <span className="fm-devices-dot" data-tone="ok" />
          <span className="fm-devices-text">
            <span className="fm-devices-name">{here(HERE.This)}</span>
            <span className="fm-devices-detail">
              Your first mate lives {fromAView ? "there" : "here"}
            </span>
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

/**
 * What Your devices says first. On a computer that controls the first mate,
 * "here" would name the wrong computer, so it names that one instead.
 */
function devicesIntro(fromAView: boolean): string {
  // A computer that controls the first mate does not know that computer's
  // system, so it says the sentence that holds on each.
  const reads = fromAView
    ? anotherUserHere("linux").reads
    : anotherUserHere(thisDesktop().mac ? "darwin" : "linux").readsHere;
  return `Your first mate lives on ${HERE.this}. Its tasks and conversation stay ${fromAView ? "there" : "here"}. From any ${COMPUTER.one} you add you can control it, and any ${COMPUTER.one} you add can run a project's work. Running as another user on ${HERE.this} only runs work. ${reads}`;
}

/**
 * The list's order (design skill `components/devices/DevicesTab`): another
 * user on this Mac right after This Mac, then each Mac in the order it joined.
 */
function inListOrder(devices: readonly DeviceView[]): DeviceView[] {
  const here = (device: DeviceView) => deviceRunsWork(device.kind) && device.onThisMac === true;
  return [...devices.filter(here), ...devices.filter((device) => !here(device))];
}
