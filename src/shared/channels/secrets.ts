import { z } from "zod";
import { secretBringInputSchema, secretBringSchema } from "../secretBring";
import {
  secretActionSchema,
  secretApprovalsInputSchema,
  secretApprovalsSchema,
  secretDecisionInputSchema,
  secretDecisionSchema,
  secretEnrollInputSchema,
  secretEntryInputSchema,
  secretKeepInputSchema,
  secretKeepSchema,
  secretRehearsalInputSchema,
  secretRehearsalSchema,
  secretsViewSchema,
} from "../secrets";
import type { ChannelDeclaration } from "./common";

/** Protected Secrets management stays on the home; only explicit paired approvals and an ask's Keep travel. */
export const secretsChannels = {
  // A phone's approvals (docs/secrets.md, "Remote decisions"): a paired view asks, and only
  // an enrolled key's signature or the captain's confirmation on the home changes anything.
  "inf:secrets:approvals": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([secretApprovalsInputSchema]),
    response: secretApprovalsSchema,
  },
  "inf:secrets:enroll": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([secretEnrollInputSchema]),
    response: secretApprovalsSchema,
  },
  "inf:secrets:decide": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([secretDecisionInputSchema]),
    response: secretDecisionSchema,
  },
  // Keep on an agent's ask card (docs/secrets.md, "Asking to keep a secret"): the
  // window that shows it, here, on another Mac or on the phone, sends the typed
  // values with the card's one-time pass. It adds or replaces only what the
  // card asked for, and never reads a value back.
  "inf:secrets:keep": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([secretKeepInputSchema]),
    response: secretKeepSchema,
  },
  // Bring into Secrets on a bring card (docs/secrets.md, "Bringing secrets from
  // another tool"): the window that shows it sends the card's one-time pass and
  // the ids of the ticked rows, never a value. Infinitary runs or reads the
  // source itself, inside the core, and keeps only the ticked rows.
  "inf:secrets:bring": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([secretBringInputSchema]),
    response: secretBringSchema,
  },
  // Whether this build keeps protected storage at all: a build without it offers no Secrets
  // tab, and the answer opens nothing (docs/secrets.md, "A build without protected storage").
  "inf:secrets:shown": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ shown: z.boolean() }),
  },
  "inf:secrets:view": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: secretsViewSchema,
  },
  "inf:secrets:entry": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([secretEntryInputSchema]),
    response: secretsViewSchema,
  },
  "inf:secrets:action": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([secretActionSchema]),
    response: secretsViewSchema,
  },
  "inf:secrets:rehearse": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([secretRehearsalInputSchema]),
    response: secretRehearsalSchema,
  },
  "inf:secrets:history": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.string().nullable(),
  },
  "inf:secrets:export": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.object({ saved: z.boolean() }),
  },
} as const satisfies Record<string, ChannelDeclaration>;
