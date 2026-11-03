import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appPathsFor } from "../../src/core/paths";

/**
 * INF-2394 measure 4: a paired Mac reached from elsewhere keeps its real pairing plus its dialed address.
 * @journey-area src/core/devices/pairing.ts
 * @journey-area src/core/devices/locality.ts
 */
export function seedRemotePairing(userDataDir: string, deviceId: string, address: string): void {
  const devicesDir = appPathsFor(userDataDir).devicesDir;
  const file = join(devicesDir, "devices.json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    devices: { id: string; onThisMac?: boolean }[];
  };
  for (const entry of saved.devices) if (entry.id === deviceId) entry.onThisMac = false;
  writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  writeFileSync(
    join(devicesDir, "reached.json"),
    JSON.stringify({ version: 1, reached: { [deviceId]: address } }),
    { mode: 0o600 },
  );
}
