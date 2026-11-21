import { z } from "zod";

/**
 * Which updates an installation is offered (docs/alpha.md "Update
 * channels"): the installed cask remembers it, independently of the
 * version running.
 *
 * Its own module, reaching nothing but zod: the release workflow's feed
 * writer loads it from a checkout of committed files alone, where nothing
 * the project generates, such as the compiled message catalog, exists
 * (docs/alpha.md, "One atomic feed snapshot").
 */
export const updateChannelSchema = z.enum(["stable", "alpha"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
