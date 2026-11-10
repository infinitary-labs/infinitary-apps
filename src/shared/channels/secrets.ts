import { z } from "zod";
import {
  secretActionSchema,
  secretApprovalsInputSchema,
  secretApprovalsSchema,
  secretDecisionInputSchema,
  secretDecisionSchema,
  secretEnrollInputSchema,
  secretEntryInputSchema,
  secretRehearsalInputSchema,
  secretRehearsalSchema,
  secretsViewSchema,
} from "../secrets";
import type { ChannelDeclaration } from "./common";

/** Protected Secrets management stays on the home; only explicit paired approvals travel. */
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
