import { parseInvokeRequest } from "@shared/ipc";
import type { PhonePushAnswer } from "@shared/phonePush";
import type { DevicePairing } from "./devices/pairing";
import type { CoreActor } from "./dispatcher";
import type { PhoneDiagnosticEvent, SharingService } from "./sharing/sharingService";

/**
 * A paired phone's own word, which only that phone hands, named by the
 * connection: its usage events (docs/sharing.md, "A phone's events") and
 * where its cards are pushed (docs/phone-push.md). The computer's window,
 * the local door and a Mac are refused.
 */
export const PHONE_ASKS = {
  "inf:settings:sharing:phone": "A phone's usage event is handed only by a paired phone.",
  "inf:devices:push": "Where a phone's cards are pushed is handed only by that paired phone.",
} as const;
export type PhoneAsk = keyof typeof PHONE_ASKS;

export function isPhoneAsk(channel: string): channel is PhoneAsk {
  return Object.hasOwn(PHONE_ASKS, channel);
}

/** The dispatcher's table entry: the ask is answered in `answerPhoneAsk`, which knows the phone. */
export function phoneOnly(channel: PhoneAsk): () => never {
  return () => {
    throw new Error(PHONE_ASKS[channel]);
  };
}

export async function answerPhoneAsk(
  services: {
    sharing: Pick<SharingService, "recordPhone">;
    devices: Pick<DevicePairing, "setPush">;
  },
  channel: PhoneAsk,
  rawArgs: unknown,
  actor: CoreActor | undefined,
): Promise<PhonePushAnswer | null> {
  if (actor?.kind !== "captain" || !actor.view) throw new Error(PHONE_ASKS[channel]);
  if (channel === "inf:devices:push") {
    // Pairing refuses a device that is not a phone.
    const [registration] = parseInvokeRequest("inf:devices:push", rawArgs);
    return services.devices.setPush(actor.view, registration);
  }
  // A phone's usage event goes under that phone's own install ID.
  const [event] = parseInvokeRequest("inf:settings:sharing:phone", rawArgs);
  services.sharing.recordPhone(
    actor.view,
    { name: event.name, data: event.data } as PhoneDiagnosticEvent,
    event.version,
    event.at,
  );
  return null;
}
