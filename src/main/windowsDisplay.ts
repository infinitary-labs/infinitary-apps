import type { BrowserWindow } from "electron";
import koffi from "koffi";
import { DISPLAY_STATUS_GUID, displayOff, POWER_SETTING_BYTES } from "./presenceWatch";

/** `WM_POWERBROADCAST`, and its `PBT_POWERSETTINGCHANGE` event. */
const WM_POWERBROADCAST = 0x0218;
const PBT_POWERSETTINGCHANGE = 0x8013;

type DisplayApi = {
  register: (window: bigint, guid: Buffer, flags: number) => unknown;
  unregister: (handle: unknown) => number;
  copy: (into: Buffer, from: bigint, bytes: number) => void;
};

let api: DisplayApi | null | undefined;

/** Windows' own calls for the display's state, or null where they do not load. */
function displayApi(): DisplayApi | null {
  if (api !== undefined) return api;
  try {
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    api = {
      register: user32.func(
        // i18n-exempt: a Windows function's signature
        "void * __stdcall RegisterPowerSettingNotification(uintptr_t hRecipient, void *PowerSettingGuid, uint32_t Flags)",
      ),
      // i18n-exempt: a Windows function's signature
      unregister: user32.func("int __stdcall UnregisterPowerSettingNotification(void *Handle)"),
      copy: kernel32.func(
        // i18n-exempt: a Windows function's signature
        "void __stdcall RtlMoveMemory(_Out_ uint8_t *Destination, uintptr_t Source, size_t Length)",
      ),
    };
  } catch {
    api = null;
  }
  return api;
}

/** A pointer-sized value Electron hands over as its raw bytes. */
function pointerOf(bytes: Buffer): bigint {
  return bytes.length >= 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0));
}

/**
 * Hears the display turn off and on, which Windows tells only a window
 * that asked (`RegisterPowerSettingNotification` with
 * `GUID_SESSION_DISPLAY_STATUS`); it says the current state at once.
 * Where the call fails, nothing is heard and the lock alone still counts.
 * Answers how to stop.
 */
export function watchWindowsDisplay(win: BrowserWindow, told: (off: boolean) => void): () => void {
  const calls = displayApi();
  if (!calls) return () => {};
  let handle: unknown = null;
  try {
    win.hookWindowMessage(WM_POWERBROADCAST, (wParam, lParam) => {
      if (Number(pointerOf(wParam)) !== PBT_POWERSETTINGCHANGE) return;
      const setting = Buffer.alloc(POWER_SETTING_BYTES);
      calls.copy(setting, pointerOf(lParam), POWER_SETTING_BYTES);
      const off = displayOff(setting);
      if (off !== null) told(off);
    });
    handle = calls.register(pointerOf(win.getNativeWindowHandle()), DISPLAY_STATUS_GUID, 0);
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (handle) calls.unregister(handle);
    } catch {}
  };
}
