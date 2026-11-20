import type { SteppedDown, TakeOverOffer } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { useState } from "react";
import { Button } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { joinedWhen } from "./devicesWords";
import { ROW_GAP, SECTION_GAP, SectionLabel } from "./settingRows";

/**
 * Take over, under Controlling on a Mac that keeps a copy while the first
 * mate's computer is out of reach (design skill
 * `components/devices/DevicesTab`, "Taking over"; docs/devices.md, "Taking
 * over"): when this copy is from, whether that computer said goodbye, every
 * other copy with whether it may be newer, and the button, which asks once
 * in place with Stay focused, then Touch ID or the password on a Mac, or
 * Windows Hello or the Windows password on a Windows PC.
 */
export function TakeOverSection({ name, offer }: { name: string; offer: TakeOverOffer }) {
  const [asking, setAsking] = useState(false);
  const [taking, setTaking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <TakeOverSectionView
      name={name}
      offer={offer}
      now={Date.now()}
      asking={asking}
      taking={taking}
      said={said}
      onAsk={(next) => {
        setAsking(next);
        setSaid(null);
      }}
      onTakeOver={() => {
        setTaking(true);
        // On success the window starts over as this computer's own first mate.
        void window.infinitary.devices
          .takeOver()
          .then((outcome) => {
            if (!outcome.ok) setSaid(outcome.text);
          })
          .catch(() => setSaid(m.settingsTakeOverFailed()))
          .finally(() => {
            setTaking(false);
            setAsking(false);
          });
      }}
    />
  );
}

export type TakeOverSectionViewProps = {
  name: string;
  offer: TakeOverOffer;
  now: number;
  asking: boolean;
  taking: boolean;
  said: string | null;
  onAsk: (asking: boolean) => void;
  onTakeOver: () => void;
};

export function TakeOverSectionView({
  name,
  offer,
  now,
  asking,
  taking,
  said,
  onAsk,
  onTakeOver,
}: TakeOverSectionViewProps) {
  const running = taking || offer.asked?.state === "running";
  const answer = said ?? (offer.asked?.state === "refused" ? offer.asked.text : null);
  return (
    <div data-take-over="" style={{ marginTop: SECTION_GAP }}>
      <SectionLabel>{m.settingsTakeOverLabel()}</SectionLabel>
      <div className="fm-devices-say">
        {m.settingsTakeOverSay({ name, when: joinedWhen(offer.copyAt, now) })}
      </div>
      <div className="fm-devices-box">
        <div className="fm-devices-row" data-take-over-row="">
          <span className="fm-devices-dot" data-tone="warn" />
          <span className="fm-devices-text">
            <span className="fm-devices-name">
              {offer.goodbye === "sleep"
                ? m.settingsTakeOverSlept({ name })
                : offer.goodbye === "quit"
                  ? m.settingsTakeOverQuit({ name })
                  : m.settingsTakeOverLost({ name })}
            </span>
            {offer.copies.map((copy) => (
              <span className="fm-devices-detail" data-take-over-copy={copy.name} key={copy.name}>
                {copy.copyAt === null
                  ? m.settingsTakeOverCopyNone({ name: copy.name })
                  : m.settingsTakeOverCopy({
                      name: copy.name,
                      when: joinedWhen(copy.copyAt, now),
                      home: name,
                    })}
                {copy.newer && (
                  <span className="fm-devices-version" data-tone="warn" data-newer="">
                    {m.settingsTakeOverNewer()}
                  </span>
                )}
              </span>
            ))}
            {!offer.ready && (
              <span className="fm-devices-question">{m.settingsTakeOverNeverTold({ name })}</span>
            )}
            {asking && (
              <>
                <span className="fm-devices-question">
                  {thisDesktop().windows ? m.settingsTakeOverAskWindows() : m.settingsTakeOverAsk()}
                </span>
                <span className="fm-devices-question">{m.settingsTakeOverAfter({ name })}</span>
              </>
            )}
            {running && offer.asked?.state === "running" && (
              <span className="fm-devices-question" role="status">
                {offer.asked.text}
              </span>
            )}
            {answer && !running && (
              <span className="fm-devices-question" role="status" data-take-over-said="">
                {answer}
              </span>
            )}
          </span>
          {asking ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                autoFocus
                disabled={running}
                onClick={() => onAsk(false)}
              >
                {m.settingsControllingStay()}
              </Button>
              <Button
                variant="danger"
                size="sm"
                pending={running}
                pendingLabel={m.settingsTakeOverTaking()}
                onClick={onTakeOver}
              >
                {m.settingsTakeOverButton()}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={!offer.ready || running}
              pending={running}
              pendingLabel={m.settingsTakeOverTaking()}
              onClick={() => onAsk(true)}
            >
              {m.settingsTakeOverButton()}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A second first mate answered with the same home number after another take
 * over (docs/devices.md, "Two homes with one number"): this Mac stays with
 * the one it knew, refuses the other, and says which to quit.
 */
export function TwoHomesNote({ name, other }: { name: string; other: string | null }) {
  return (
    <div className="fm-devices-box" data-two-homes="" style={{ marginTop: SECTION_GAP }}>
      <div className="fm-devices-row">
        <span className="fm-devices-dot" data-tone="danger" />
        <span className="fm-devices-text">
          <span className="fm-devices-name">
            {other ? m.settingsTwoHomesNamed({ other }) : m.settingsTwoHomes()}
          </span>
          <span className="fm-devices-question" role="status">
            {m.settingsTwoHomesStay({ name })}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * Two first mates answer with this one's number (docs/devices.md, "Two homes
 * with one number"), on the home's Devices: merges, pushes and secret uses
 * wait until the captain keeps one. Keep this one gives it the next number,
 * so the other steps down once it hears it; Keep the other steps this one
 * down to it.
 */
export function KeepHomeQuestion({ other }: { other: { deviceId: string; name: string } }) {
  const [keeping, setKeeping] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const keep = (choice: string) => {
    setKeeping(choice);
    setSaid(null);
    void window.infinitary.devices.standby
      .keepHome(choice)
      .then((answer) => setSaid(answer.text))
      .catch(() => setSaid(m.settingsKeepHomeFailed()))
      .finally(() => setKeeping(null));
  };
  return (
    <KeepHomeQuestionView
      other={other.name}
      keeping={keeping}
      said={said}
      onKeep={(here) => keep(here ? "here" : other.deviceId)}
    />
  );
}

export function KeepHomeQuestionView({
  other,
  keeping,
  said,
  onKeep,
}: {
  other: string;
  keeping: string | null;
  said: string | null;
  onKeep: (here: boolean) => void;
}) {
  return (
    <div data-keep-home="" style={{ marginBottom: 16 }}>
      <SectionLabel>{m.settingsKeepHomeLabel()}</SectionLabel>
      <div className="fm-devices-box">
        <div className="fm-devices-row">
          <span className="fm-devices-dot" data-tone="danger" />
          <span className="fm-devices-text">
            <span className="fm-devices-name">{m.settingsKeepHomeSay({ other })}</span>
            <span className="fm-devices-question">{m.settingsKeepHomeWaits()}</span>
            {said && (
              <span className="fm-devices-question" role="status" data-keep-home-said="">
                {said}
              </span>
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={keeping !== null}
            pending={keeping !== null && keeping !== "here"}
            onClick={() => onKeep(false)}
          >
            {m.settingsKeepHomeOther({ other })}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={keeping !== null}
            pending={keeping === "here"}
            onClick={() => onKeep(true)}
          >
            {m.settingsKeepHomeHere()}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * This Mac was the first mate's computer until a computer that kept a copy
 * took over (docs/devices.md, "An old home that returns"), under Controlling:
 * what it saved after that copy, which never reached it. Its record stays
 * set aside on this Mac.
 */
export function SteppedDownNote({ steppedDown, now }: { steppedDown: SteppedDown; now: number }) {
  return (
    <div data-stepped-down="" style={{ marginTop: SECTION_GAP }}>
      <SectionLabel>{m.settingsSteppedDownLabel()}</SectionLabel>
      <div className="fm-devices-say">
        {steppedDown.since === null
          ? m.settingsSteppedDownSayNone({ name: steppedDown.from })
          : m.settingsSteppedDownSay({
              name: steppedDown.from,
              when: joinedWhen(steppedDown.since, now),
            })}
      </div>
      <div className="fm-devices-box">
        {steppedDown.lines.length === 0 ? (
          <div className="fm-devices-row">
            <span className="fm-devices-dot" data-tone="ok" />
            <span className="fm-devices-text">
              <span className="fm-devices-name">
                {m.settingsSteppedDownNothing({ name: steppedDown.from })}
              </span>
            </span>
          </div>
        ) : (
          steppedDown.lines.map((line) => (
            <div
              className="fm-devices-row"
              data-never-sent=""
              key={`${line.at}-${line.task}-${line.text}`}
            >
              <span className="fm-devices-dot" data-tone="warn" />
              <span className="fm-devices-text">
                <span className="fm-devices-name">{line.task}</span>
                <span className="fm-devices-detail">
                  {line.text} · {joinedWhen(line.at, now)}
                </span>
              </span>
            </div>
          ))
        )}
      </div>
      <div className="fm-devices-say" style={{ margin: `${ROW_GAP} 0 0` }}>
        {m.settingsSteppedDownKept()}
      </div>
    </div>
  );
}
