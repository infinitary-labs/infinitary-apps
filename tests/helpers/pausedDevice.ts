import { once } from "node:events";
import { dialHome } from "@core/devices/dial";
import type { DeviceGrant } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";

/** A real device that stops reading before the home quits, delaying its close reply. */
export async function pausedDevice(grant: DeviceGrant, hello = true) {
  const ws = await dialHome(grant);
  const closed = once(ws, "close").then(([code]) => code as number);
  await once(ws, "open");
  if (hello) {
    ws.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION }));
    await once(ws, "message");
  }
  ws.pause();
  return { ws, closed };
}
