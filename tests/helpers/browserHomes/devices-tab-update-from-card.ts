import {
  type DeviceUpdateNudgeFacts,
  deviceUpdateActions,
  deviceUpdateBody,
  deviceUpdateCardId,
  deviceUpdateMeta,
  deviceUpdateTitle,
} from "@shared/deviceUpdateNudge";
import { hostCard } from "../../../src/core/orchestrator/hostCards";
import { CardStore } from "../../../src/core/storage/cardStore";
import { openDatabase } from "../../../src/core/storage/db";
import type { HomeRead } from "../browserFreshHome";

/** The computer the test's card is about, the Devices harness's Mac mini. */
const DEVICE_ID = "mini";

/** The card's thread, read when it shows. */
export const asked: HomeRead[] = [["inf:cards:thread", [deviceUpdateCardId(DEVICE_ID)]]];

/**
 * The update card the host raises for a computer it cannot update alone
 * (src/core/devices/deviceUpdateNudge.ts), built from the same facts and
 * stamped as the host stamps its own cards, waiting in the stack as the
 * window opens.
 */
export default function seed(userDataDir: string, facts: DeviceUpdateNudgeFacts): void {
  if (facts.deviceId !== DEVICE_ID)
    throw new Error(`The seed reads the thread of ${DEVICE_ID}'s card, not ${facts.deviceId}'s`);
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert({
      ...hostCard({
        id: deviceUpdateCardId(facts.deviceId),
        title: deviceUpdateTitle(facts),
        meta: deviceUpdateMeta(facts),
        body: deviceUpdateBody(facts),
        actions: deviceUpdateActions(facts),
      }),
      createdAt: Date.now(),
    });
  } finally {
    db.close();
  }
}
