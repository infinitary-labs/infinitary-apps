import { COMMAND_NOTICE_WORDS } from "@shared/commandNotice";
import { describe, expect, it } from "vitest";
import { macStartReasonFromLog } from "./macStartReason";

// INF-7226 recorded these launchd lines on a disposable macOS 26.6.2 Mac.
const denied = [
  "2026-11-28 07:42:50.459 E  launchd[1:2712] [gui/501/com.getinfinitary.infinitary.run [1182]:] Service could not initialize: posix_spawn(/Applications/Infinitary.app/Contents/MacOS/Infinitary), error 0xd - Permission denied",
  "2026-11-28 07:43:00.469 E  launchd[1:2765] [gui/501/com.getinfinitary.infinitary.run [1187]:] Service could not initialize: posix_spawn(/Applications/Infinitary.app/Contents/MacOS/Infinitary), error 0xd - Permission denied",
].join("\n");
const label = "com.getinfinitary.infinitary.run";

describe("the stopped notice's macOS reason", () => {
  it("uses the current start's recorded launchd reason, not an earlier attempt or another account", () => {
    const start = new Date(2026, 10, 28, 7, 42, 55).getTime();
    expect(macStartReasonFromLog(denied, 501, label, start)).toEqual({
      kind: "reason",
      text: "Service could not initialize: posix_spawn(/Applications/Infinitary.app/Contents/MacOS/Infinitary), error 0xd - Permission denied",
    });
    expect(
      macStartReasonFromLog(denied, 501, label, new Date(2026, 10, 28, 7, 43, 1).getTime()),
    ).toBeNull();
    expect(macStartReasonFromLog(denied, 502, label, start)).toBeNull();
  });

  it("shows the recorded reason and the log-access refusal in the stopped notice", () => {
    const start = new Date(2026, 10, 28, 7, 42, 55).getTime();
    const reason = macStartReasonFromLog(denied, 501, label, start);
    const unreadable = macStartReasonFromLog(
      "log: Could not open local log store: Operation not permitted",
      501,
      label,
      start,
    );
    expect(
      COMMAND_NOTICE_WORDS.line({
        state: "stopped",
        ending: "crashed",
        byWindow: true,
        ...(reason ? { macStartDiagnostic: reason } : {}),
      }),
    ).toBe(
      "macOS could not start your first mate: Service could not initialize: posix_spawn(/Applications/Infinitary.app/Contents/MacOS/Infinitary), error 0xd - Permission denied",
    );
    expect(
      COMMAND_NOTICE_WORDS.line({
        state: "stopped",
        ending: "crashed",
        byWindow: true,
        ...(unreadable ? { macStartDiagnostic: unreadable } : {}),
      }),
    ).toBe(
      "Your first mate could not start. This account cannot read the macOS log that may say why.",
    );
  });

  it("reports the recorded standard-account log refusal without calling it the start failure", () => {
    expect(
      macStartReasonFromLog(
        "log: Could not open local log store: Operation not permitted",
        501,
        label,
        Date.now(),
      ),
    ).toEqual({ kind: "unreadable" });
  });
});
