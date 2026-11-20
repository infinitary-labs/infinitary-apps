import type { DeviceView } from "./devices";
import { runsForAnotherFirstmate } from "./sshConnection";

/**
 * Which of a computer's own acts its row in Settings → Devices offers, read
 * once for the row and for the first mate's card that opens it
 * (`src/shared/handoverActions.ts`), so a card never sends the captain to a
 * control the row does not show. `settling` is the row's own: a removal,
 * an update or a move under way there, which the first mate's card reads
 * as the computer's removal alone. A computer that left for another first
 * mate offers only Remove.
 */

/** Change address: a computer added by its address that this computer reaches over SSH. */
export function offersAddressChange(device: DeviceView, settling = false): boolean {
  return (
    Boolean(device.ssh && device.remoteLogin) && !settling && !runsForAnotherFirstmate(device.ssh)
  );
}

/**
 * Move your first mate here (design skill `components/devices/DevicesTab`,
 * "Moving your first mate"): one that runs work, in reach, on this
 * computer's version, and not settling.
 */
export function offersHomeMove(device: DeviceView, settling = false): boolean {
  return (
    device.inReach === true &&
    !settling &&
    !device.otherVersion &&
    device.removal === undefined &&
    !runsForAnotherFirstmate(device.ssh)
  );
}

/** Keep a copy here: one that runs work, keeps no copy yet and is not being removed. */
export function offersStandby(device: DeviceView, keepsCopy: boolean): boolean {
  return device.removal === undefined && !keepsCopy && !runsForAnotherFirstmate(device.ssh);
}
