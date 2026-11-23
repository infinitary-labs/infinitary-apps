import type { DeviceView } from "@shared/devices";
import { deviceLabel } from "@shared/devices";
import type { HomeMoveProgress, HomeMoveReady } from "@shared/homeMove";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useState } from "react";
import { Button } from "../design";
import { useHereAs } from "../devices/useFirstMatePlace";

/** The steps after which the first mate is already stopping: no cancel from there. */
const PAST_CANCEL: readonly HomeMoveProgress["stage"][] = ["stopping", "arriving", "moved"];
const ENDED: readonly HomeMoveProgress["stage"][] = ["moved", "failed", "cancelled"];

/**
 * Which computer's Ready list is open, and the move's own progress, which
 * opens it again on whichever computer the move is going to.
 */
export function useHomeMove(devices: readonly DeviceView[]): {
  asking: string | null;
  progress: HomeMoveProgress | null;
  ask: (deviceId: string | null) => void;
} {
  const [asking, setAsking] = useState<string | null>(null);
  const [progress, setProgress] = useState<HomeMoveProgress | null>(null);
  useEffect(() => {
    const homeMove = window.infinitary?.devices?.homeMove;
    if (!homeMove) return;
    return homeMove.onProgress((next) => {
      setProgress(next);
      setAsking(next.deviceId);
    });
  }, []);
  useEffect(() => {
    if (asking && !progress && !devices.some((device) => device.id === asking)) setAsking(null);
  }, [asking, devices, progress]);
  return {
    asking,
    progress,
    ask: (deviceId) => {
      setAsking(deviceId);
      if (deviceId === null || (progress && ENDED.includes(progress.stage))) setProgress(null);
    },
  };
}

function countOf(progress: HomeMoveProgress): string | null {
  if (progress.total === undefined || progress.done === undefined || progress.total === 0)
    return null;
  if (progress.stage === "copying")
    return `${Math.min(100, Math.floor((progress.done / progress.total) * 100))}%`;
  return `${progress.done}/${progress.total}`;
}

/**
 * The Ready list under a computer's row (design skill
 * `components/devices/DevicesTab`, "Moving your first mate"): each gap on that
 * computer before the move, Move now while nothing blocks, and each step of
 * the move once it runs.
 */
export function HomeMoveQuestion({
  device,
  progress,
  onClose,
}: {
  device: DeviceView;
  progress: HomeMoveProgress | null;
  onClose: () => void;
}) {
  const here = useHereAs();
  const label = deviceLabel(device);
  const [ready, setReady] = useState<HomeMoveReady | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sure, setSure] = useState(false);
  const ours = progress?.deviceId === device.id ? progress : null;
  const running = ours !== null && !ENDED.includes(ours.stage);
  useEffect(() => {
    if (running) return;
    let current = true;
    setReady(null);
    window.infinitary.devices.homeMove
      .ready(device.id)
      .then((answer) => {
        if (current) setReady(answer);
      })
      .catch(() => {
        if (current) setProblem(m.settingsDevicesMoveCouldNot({ device: label }));
      });
    return () => {
      current = false;
    };
  }, [device.id, label, running]);
  const blocks = ready?.gaps.filter((gap) => gap.level === "blocks") ?? [];
  const move = () => {
    setStarting(true);
    setProblem(null);
    void window.infinitary.devices.homeMove
      .start(device.id)
      .then((answer) => {
        if (!answer.ok) setProblem(answer.text);
      })
      .catch(() => setProblem(m.settingsDevicesMoveCouldNot({ device: label })))
      .finally(() => setStarting(false));
  };
  const cancel = () => {
    void window.infinitary.devices.homeMove
      .cancel()
      .then((answer) => {
        if (!answer.ok) setProblem(answer.text);
      })
      .catch(() => {});
  };
  const startHere = () => {
    setProblem(null);
    void window.infinitary.devices.homeMove
      .startHere()
      .then((answer) => {
        if (!answer.ok) setProblem(answer.text);
      })
      .catch(() => setProblem(m.settingsDevicesMoveCouldNot({ device: label })))
      .finally(() => setSure(false));
  };
  const count = ours ? countOf(ours) : null;
  return (
    <div className="fm-devices-aside" data-home-move={device.id} data-stage={ours?.stage}>
      <div className="fm-devices-question">{m.settingsDevicesMoveQuestion({ device: label })}</div>
      <div className="fm-devices-aside-say">{m.settingsDevicesMoveSay({ device: label })}</div>
      {ours ? (
        <div
          className="fm-devices-aside-say fm-devices-move-step"
          role="status"
          data-tone={ours.stage === "failed" ? "warn" : undefined}
        >
          {here(ours.text)}
          {count && running && <span className="fm-devices-move-count">{count}</span>}
        </div>
      ) : ready === null && !problem ? (
        <div className="fm-devices-aside-say" role="status">
          {m.settingsDevicesMoveChecking({ device: label })}
        </div>
      ) : ready && ready.gaps.length === 0 ? (
        <div className="fm-devices-aside-say">{m.settingsDevicesMoveNothing()}</div>
      ) : ready ? (
        <ul className="fm-devices-move-gaps" data-home-move-gaps="">
          {ready.gaps.map((gap) => (
            <li key={gap.id} data-level={gap.level} data-gap={gap.id}>
              {here(gap.text)}
            </li>
          ))}
        </ul>
      ) : null}
      {problem && (
        <div className="fm-devices-aside-say" data-tone="warn" role="alert">
          {here(problem)}
        </div>
      )}
      {running && ours.startHere && sure && (
        <div className="fm-devices-aside-say" data-tone="warn" role="alert" data-home-move-sure="">
          {m.settingsDevicesMoveStartHereSure({ device: label })}
        </div>
      )}
      <div className="fm-devices-aside-actions">
        {running && ours.startHere ? (
          sure ? (
            <>
              <Button size="sm" onClick={startHere}>
                {m.settingsDevicesMoveStartHereConfirm()}
              </Button>
              <Button variant="ghost" size="sm" autoFocus onClick={() => setSure(false)}>
                {m.settingsDevicesMoveKeepWaiting()}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setSure(true)}>
              {m.settingsDevicesMoveStartHere()}
            </Button>
          )
        ) : running ? (
          !PAST_CANCEL.includes(ours.stage) && (
            <Button variant="ghost" size="sm" onClick={cancel}>
              {m.settingsDevicesMoveCancel()}
            </Button>
          )
        ) : (
          <>
            {ours?.stage !== "moved" && (
              <Button
                size="sm"
                disabled={ready === null || blocks.length > 0}
                pending={starting}
                onClick={move}
              >
                {m.settingsDevicesMoveNow()}
              </Button>
            )}
            <Button variant="ghost" size="sm" autoFocus onClick={onClose}>
              {m.settingsDevicesMoveNotNow()}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
