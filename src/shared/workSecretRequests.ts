import { z } from "zod";
import { asked } from "./workIdentity";
import {
  placedSecretAskAnswerSchema,
  placedSecretAskInputSchema,
  placedSecretBringAnswerSchema,
  placedSecretBringInputSchema,
  placedSecretsSchema,
  placedSecretTakeAnswerSchema,
  placedSecretUseAnswerSchema,
  placedSecretUseInputSchema,
} from "./workSecrets";

/**
 * The Secrets command's work requests from a computer that runs work
 * (docs/secrets.md, "On a computer that runs work"), spread into
 * `workRequests` (`work.ts`). Only `inf:work:secret-take` answers values and
 * only `inf:work:secret-bring`'s delivery carries them; the home answers both
 * outside the call ledger.
 */
export const secretWorkRequests = {
  /**
   * The Secrets command's list and show: the home reads its own catalog
   * for the crewmate, the same one a crewmate of its own lists
   * (docs/secrets.md, "Current command seam"). It answers metadata only;
   * a use's values leave the home only through `inf:work:secret-take`.
   */
  "inf:work:secrets": {
    effect: "read",
    request: asked({ input: z.strictObject({}) }),
    response: placedSecretsSchema,
  },
  /** The Secrets command's uses there, decided on the home, answered with receipts, never kept. */
  "inf:work:secret-use": {
    effect: "change",
    repeats: "safe",
    request: asked({ input: placedSecretUseInputSchema }),
    response: placedSecretUseAnswerSchema,
  },
  /**
   * An approved use's values, taken once and never kept in the call ledger,
   * or the state it ended in. The take spends the values, and the same call
   * asked again after a cut-off receives the same values until the use ends.
   */
  "inf:work:secret-take": {
    effect: "change",
    repeats: "safe",
    request: asked({ request: z.string().min(1) }),
    response: placedSecretTakeAnswerSchema,
  },
  /**
   * The Secrets command's ask to keep a secret there, raised on the home's
   * own card (`secret-asks-elsewhere.md`; docs/secrets.md, "Asking to keep a
   * secret"): names, places, a reason and the asker's id, or a withdrawal,
   * never a value. Asked again with a waiting ask's id, it raises nothing new.
   */
  "inf:work:secret-ask": {
    effect: "change",
    repeats: "safe",
    request: asked({ input: placedSecretAskInputSchema }),
    response: placedSecretAskAnswerSchema,
  },
  /**
   * The Secrets command's bring from another tool there, raised on the
   * home's own card (`secret-brings-elsewhere.md`; docs/secrets.md,
   * "Bringing secrets from another tool"): the source bound there, then the
   * captain's press, and what it read sent once. Never kept in the call
   * ledger, since a delivery carries values.
   */
  "inf:work:secret-bring": {
    effect: "change",
    repeats: "safe",
    request: asked({ input: placedSecretBringInputSchema }),
    response: placedSecretBringAnswerSchema,
  },
} as const;
