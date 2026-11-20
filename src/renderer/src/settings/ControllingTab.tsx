import { useState } from "react";
import { Button } from "../design";
import type { ViewMac } from "../devices/viewWords";
import { joinedWhen } from "./devicesWords";
import "./devices.css";
import * as m from "@shared/i18n/messages.generated";
import { SECTION_GAP, SectionLabel } from "./settingRows";
import { SteppedDownNote, TakeOverSection, TwoHomesNote } from "./TakeOverSection";

/**
 * Settings -> Devices on a Mac that controls Firstmate on another (design
 * skill `components/devices/RemoteControl`, docs/view.md): which Mac, when
 * this one joined it and at what address, and Leave, which asks once in
 * place with Stay focused so Enter never leaves.
 */
export function ControllingTab({ mac }: { mac: ViewMac }) {
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <ControllingTabView
        mac={mac}
        now={Date.now()}
        asking={asking}
        leaving={leaving}
        onAsk={setAsking}
        onLeave={() => {
          setLeaving(true);
          // The window starts over as this Mac's own first launch.
          void window.infinitary.devices.leave().catch(() => setLeaving(false));
        }}
      />
      {mac.carriedOn && <CarriedOnNote name={mac.name} />}
      {mac.twoHomes && <TwoHomesNote name={mac.name} other={mac.twoHomes.name} />}
      {mac.steppedDown && <SteppedDownNote steppedDown={mac.steppedDown} now={Date.now()} />}
      {mac.takeOver && <TakeOverSection name={mac.name} offer={mac.takeOver} />}
    </>
  );
}

/**
 * The first mate's computer removed the row this window held - by a fold
 * into the row this Mac's work keeps, or the captain's Remove - while that
 * work still runs for it, and the window carries on as that row
 * (docs/view.md, "A Mac that runs work").
 */
function CarriedOnNote({ name }: { name: string }) {
  return (
    <div className="fm-devices-box" data-carried-on="" style={{ marginTop: SECTION_GAP }}>
      <div className="fm-devices-row">
        <span className="fm-devices-dot" data-tone="ok" />
        <span className="fm-devices-text">
          <span className="fm-devices-question" role="status">
            {m.settingsControllingCarriedOn({ name })}
          </span>
        </span>
      </div>
    </div>
  );
}

export type ControllingTabViewProps = {
  mac: ViewMac;
  now: number;
  asking: boolean;
  leaving: boolean;
  onAsk: (asking: boolean) => void;
  onLeave: () => void;
};

export function ControllingTabView({
  mac,
  now,
  asking,
  leaving,
  onAsk,
  onLeave,
}: ControllingTabViewProps) {
  const away = mac.contact === "lost" || mac.contact === "closed";
  return (
    <div data-controlling="">
      <SectionLabel>{m.settingsControllingLabel()}</SectionLabel>
      <div className="fm-devices-say">{m.settingsControllingSay({ name: mac.name })}</div>
      <div className="fm-devices-box">
        {asking ? (
          <div className="fm-devices-row" data-leaving={mac.name}>
            <span className="fm-devices-dot" data-tone={away ? undefined : "ok"} />
            <span className="fm-devices-text">
              <span className="fm-devices-question">
                {mac.runsWork
                  ? m.settingsControllingLeaveRunsWork({ name: mac.name })
                  : m.settingsControllingLeave({ name: mac.name })}
              </span>
              {mac.runsWork && !away && (
                <span className="fm-devices-question">
                  {m.settingsControllingWorkGoes({ name: mac.name })}
                </span>
              )}
              <span className="fm-devices-question">
                {away
                  ? m.settingsControllingAway({ name: mac.name })
                  : m.settingsControllingNewLink()}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              disabled={leaving}
              onClick={() => onAsk(false)}
            >
              {m.settingsControllingStay()}
            </Button>
            <Button
              variant="danger"
              size="sm"
              pending={leaving}
              pendingLabel={m.settingsControllingLeaving()}
              onClick={onLeave}
            >
              {m.settingsControllingLeaveButton()}
            </Button>
          </div>
        ) : (
          <div className="fm-devices-row" data-controlling-row="">
            <span className="fm-devices-dot" data-tone={away ? "warn" : "ok"} />
            <span className="fm-devices-text">
              <span className="fm-devices-name">{mac.name}</span>
              <span className="fm-devices-detail">
                {m.settingsControllingJoined({
                  when: joinedWhen(mac.joinedAt, now),
                  address: mac.address,
                })}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-label={m.settingsControllingLeaveNamed({ name: mac.name })}
              onClick={() => onAsk(true)}
            >
              {m.settingsControllingLeaveButton()}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
