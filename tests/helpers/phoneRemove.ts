import type { Core } from "@core/index";

/**
 * The test home's `remove`: every device off the list, as Devices' Remove takes
 * each. With `feedFirst`, a feed line rides just ahead of the removal's close,
 * so a phone answering it with a read sends as the close arrives (INF-6476,
 * `PhoneWeakLinkTests`).
 */
export async function removeEveryDevice(core: Core, body: string): Promise<void> {
  if (body && (JSON.parse(body) as { feedFirst?: boolean }).feedFirst)
    core.events.emit("inf:event", { type: "firstmate_note", text: "Removing this phone." });
  for (const device of core.services.devices.list())
    await core.dispatch("inf:devices:remove", [device.id]);
}
