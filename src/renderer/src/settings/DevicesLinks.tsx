import { HERE } from "@shared/deviceNames";
import {
  type DeviceFirewall,
  type DeviceInvite,
  firewallWords,
  phoneRouteWords,
} from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useState } from "react";
import { Button } from "../design";
import { useHereAs } from "../devices/useFirstMatePlace";
import type { DevicesTabViewProps, LinkPanel } from "./devicesState";
import {
  type DevicePanelMake,
  linkTimeLeft,
  PANEL_WORDS,
  WAYS_WORDS,
  wayCount,
} from "./devicesWords";
import { PhoneCode } from "./PhoneCode";
import { SectionLabel, SettingError, SettingRow } from "./settingRows";

/**
 * Links and commands in Settings -> Devices (design skill
 * `components/devices/DevicesTab`): the panel that holds an open one, says
 * it joined or expired; how other devices find this computer, with a Copy
 * for each; and what a Linux home's firewall may keep out.
 */

/** Whether a link or command for another computer is open in the panel, which then says what the firewall may keep out. */
export function panelForAnotherComputer(panel: LinkPanel | null): boolean {
  return panel?.state === "open" && panel.make !== "user-command";
}

/**
 * A Linux home's firewall that may keep its other computers out (design
 * skill `components/devices/DevicesTab`, "A Linux home's firewall"): two
 * lines in `--warn`, and the way to let them in.
 */
export function FirewallLine({
  firewall,
  under = "panel",
}: {
  firewall: DeviceFirewall;
  under?: "panel" | "address";
}) {
  const here = useHereAs();
  const { lines, way } = firewallWords(firewall);
  return (
    <div
      className="fm-devices-firewall"
      data-device-firewall={firewall.name}
      data-under={under}
      role="note"
    >
      <div className="fm-devices-firewall-say">{here(lines.join(" "))}</div>
      <code className="fm-devices-firewall-way">{way}</code>
    </div>
  );
}

function wayState(count: number, on: boolean): { text: string; tone?: "busy" } {
  if (!on) return { text: WAYS_WORDS.off };
  if (count > 0) return { text: wayCount(count), tone: "busy" };
  return { text: WAYS_WORDS.ready };
}

export function WaysSection({ addresses, devices, busy, onCopyWay }: DevicesTabViewProps) {
  const here = useHereAs();
  if (!addresses) return null;
  const local = addresses.addresses.filter((entry) => entry.network === "local");
  const priv = addresses.addresses.filter((entry) => entry.network === "private");
  const none = local.length === 0 && priv.length === 0;
  return (
    <>
      <SectionLabel>{here(WAYS_WORDS.label)}</SectionLabel>
      {none ? (
        <SettingRow
          id="device-address"
          title={m.settingsDevicesAddressTitle()}
          description={here(WAYS_WORDS.noNetwork)}
          control={
            <span className="fm-devices-address">
              {/* Named only from a view; here it is one worded phrase, never English glued in. */}
              {here(HERE.this) === HERE.this
                ? m.settingsDevicesAddressOnlyHere()
                : m.settingsDevicesAddressOnly({ place: here(HERE.this) })}
            </span>
          }
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
            line={here(WAYS_WORDS.internetLine)}
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

export function LinkPanelView({
  panel,
  now,
  busy,
  addresses,
  onStop,
  onDone,
  onMake,
}: DevicesTabViewProps) {
  const here = useHereAs();
  if (!panel) return null;
  if (panel.state === "joined")
    return (
      <div className="fm-devices-panel" data-panel-state="joined" role="status">
        <span className="fm-devices-dot" data-tone="ok" />
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--fg-1)" }}>{here(panel.line)}</div>
          {panel.work && (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {m.settingsDevicesJoinedGiveProject()}
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {m.settingsDevicesDone()}
        </Button>
      </div>
    );
  if (panel.state === "expired")
    return (
      <div className="fm-devices-panel" data-panel-state="expired" role="status">
        <div style={{ flex: 1 }}>
          <div style={{ color: "var(--fg-1)" }}>
            {panel.make === "phone"
              ? m.settingsDevicesExpiredPhone()
              : PANEL_WORDS[panel.make].thing === "command"
                ? m.settingsDevicesExpiredCommand()
                : m.settingsDevicesExpiredLink()}
          </div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            {panel.make === "phone"
              ? m.settingsDevicesExpiredPhoneReady()
              : m.settingsDevicesExpiredComputerReady()}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy === "link"}
          onClick={() => onMake(panel.make)}
        >
          {m.settingsDevicesMakeNewOne()}
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
  const here = useHereAs();
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
      <div className="fm-devices-panel-say">{here(words.say.join(" "))}</div>
      {make === "phone" && (
        <>
          <div className="fm-devices-panel-say">{here(phoneRouteWords(invite.link))}</div>
          <PhoneCode link={invite.link} />
        </>
      )}
      {firewall && <FirewallLine firewall={firewall} />}
      <div className="fm-devices-panel-line">
        <code className="fm-devices-link" data-device-link="">
          {text}
        </code>
        <Button size="sm" onClick={() => void copy()}>
          {copied === "copied" ? m.settingsDevicesCopied() : words.copy}
        </Button>
      </div>
      <div className="fm-devices-panel-foot">
        <span className="fm-devices-count">
          {m.settingsDevicesWorksOnce({ left: linkTimeLeft(invite.expiresAt, now) })}
        </span>
        <Button variant="ghost" size="sm" onClick={onStop}>
          {m.settingsDevicesStopIt()}
        </Button>
      </div>
      {copied === "failed" && (
        <SettingError
          error={
            words.thing === "command"
              ? m.settingsDevicesCopyCommandFailed()
              : m.settingsDevicesCopyLinkFailed()
          }
        />
      )}
    </div>
  );
}
