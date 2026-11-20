import { z } from "zod";

/**
 * What Settings -> Devices makes on arrival from a card's button
 * (docs/devices.md, "Asking the first mate"): a link, the command for another
 * Mac, or the command for another user on this Mac.
 */
export const deviceMakeSchema = z.enum(["link", "command", "user-command"]);
export type DeviceMake = z.infer<typeof deviceMakeSchema>;

/**
 * What Settings -> Devices does on arrival from a card's button, carried
 * from the card's open effect: make a link or a command, remove a device,
 * add the Mac at an address over Remote Login, open + A computer's address
 * form for one the captain will name there, or update Firstmate on a Mac
 * added that way.
 */
export type DeviceArrival =
  | { make: DeviceMake | "phone" }
  | { remove: string }
  | { add: string }
  | { addressForm: true }
  | { update: string };

/** The arrival an open effect on Devices carries, as the store keeps it. */
export function deviceArrival(effect: {
  make?: DeviceMake | undefined;
  phone?: true | undefined;
  remove?: string | undefined;
  add?: string | undefined;
  addressForm?: true | undefined;
  update?: string | undefined;
}): { pendingDeviceArrival: DeviceArrival } | Record<string, never> {
  // A phone's link is its own field, so a view from before opens Devices and makes nothing.
  if (effect.phone) return { pendingDeviceArrival: { make: "phone" } };
  if (effect.make) return { pendingDeviceArrival: { make: effect.make } };
  if (effect.remove) return { pendingDeviceArrival: { remove: effect.remove } };
  if (effect.add) return { pendingDeviceArrival: { add: effect.add } };
  // Its own field too, so a view from before opens Devices and opens nothing.
  if (effect.addressForm) return { pendingDeviceArrival: { addressForm: true } };
  if (effect.update) return { pendingDeviceArrival: { update: effect.update } };
  return {};
}
