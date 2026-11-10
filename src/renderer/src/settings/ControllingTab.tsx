import { useState } from "react";
import { Button } from "../design";
import type { ViewMac } from "../devices/viewWords";
import { joinedWhen } from "./devicesWords";
import "./devices.css";
import { HERE } from "@shared/deviceNames";
import { SectionLabel } from "./settingRows";

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
      <SectionLabel>Controlling</SectionLabel>
      <div className="fm-devices-say">
        What you do here happens on {mac.name}. Its Secrets and voice stay there.
      </div>
      <div className="fm-devices-box">
        {asking ? (
          <div className="fm-devices-row" data-leaving={mac.name}>
            <span className="fm-devices-dot" data-tone={away ? undefined : "ok"} />
            <span className="fm-devices-text">
              <span className="fm-devices-question">
                {mac.runsWork
                  ? `Leave ${mac.name}? ${HERE.This} stops controlling it and running its work.`
                  : `Leave ${mac.name}? ${HERE.This} stops controlling it.`}
              </span>
              {mac.runsWork && !away && (
                <span className="fm-devices-question">
                  Its unmerged work goes to {mac.name} first.
                </span>
              )}
              <span className="fm-devices-question">
                {away
                  ? `${mac.name} is out of reach, so it lists ${HERE.this} until you remove it there.`
                  : "To control it again, make a new link there."}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              disabled={leaving}
              onClick={() => onAsk(false)}
            >
              Stay
            </Button>
            <Button
              variant="danger"
              size="sm"
              pending={leaving}
              pendingLabel="Leaving..."
              onClick={onLeave}
            >
              Leave
            </Button>
          </div>
        ) : (
          <div className="fm-devices-row" data-controlling-row="">
            <span className="fm-devices-dot" data-tone={away ? "warn" : "ok"} />
            <span className="fm-devices-text">
              <span className="fm-devices-name">{mac.name}</span>
              <span className="fm-devices-detail">
                joined {joinedWhen(mac.joinedAt, now)} · {mac.address}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Leave ${mac.name}`}
              onClick={() => onAsk(true)}
            >
              Leave
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
