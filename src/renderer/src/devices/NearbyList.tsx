import type { DeviceView } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import {
  type NearbyMac,
  type NearbyMacsView,
  nearbyAddress,
  nearbyMacsWords,
  nearbyOnList,
} from "@shared/nearbyMacs";
import { useRef, useState } from "react";
import { Input } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { focusWithRing } from "../design/focus";
import "../settings/devices.css";

/**
 * The optional port beside an address (design skill AddAMac, "By its
 * address"): empty is SSH's own, 22, or whatever the person's SSH settings
 * name for that address.
 */
export function PortField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (port: string) => void;
}) {
  return (
    <Input
      id={id}
      mono
      aria-label={m.devicesNearbyPort()}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      placeholder={m.devicesNearbyPortPlaceholder()}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{ width: 96, flex: "none" }}
    />
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
export function sshMustBeOn(): string {
  return thisDesktop().mac ? m.devicesNearbyRemoteLoginOn() : m.devicesNearbySshOn();
}

/**
 * Macs nearby with Remote Login on (design skill AddAMac, "Nearby"): each
 * by its own name, drawn as text, and the address it fills in; one already
 * on Your devices is marked. The list is one Tab stop and the arrows move
 * through it. While none answered it says it is looking; when macOS has not
 * allowed the local network, or the looking stopped, it says so. The first
 * launch's Join by its address draws the same list (`JoinAnotherMac`), with
 * the address its own Your account field fills.
 */
export function NearbyList({
  nearby,
  devices,
  onPick,
  onLeave,
  addressOf = (mac) => nearbyAddress(mac, nearby.user),
}: {
  nearby: NearbyMacsView;
  devices: readonly DeviceView[];
  onPick: (address: string) => void;
  onLeave: () => void;
  /** The address a row fills in; this Mac's user at its name unless given. */
  addressOf?: (mac: NearbyMac) => string;
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
            const address = addressOf(mac);
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
