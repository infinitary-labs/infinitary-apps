import { contractChange } from "./contractChanges";

/** A peer must preserve request/response references instead of dropping them. */
export const CREW_RESPONSES = contractChange("crew-responses");
