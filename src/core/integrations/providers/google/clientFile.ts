import * as m from "@shared/i18n/messages.generated";

/**
 * The file Google gives for a person's own Desktop app client
 * (docs/integrations.md, "Google"), as they drop or paste it:
 * `{"installed": {"client_id", "client_secret", ...}}`. A web application
 * client's file nests its fields under `web` instead; its sign-in cannot
 * return to the app on this computer the way a Desktop app client's does, so
 * it is refused with words that say which kind to make.
 */
export function readGoogleClientFile(text: string): { id: string; secret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(m.integrationsGoogleClientFileNotJson());
  }
  const file = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const installed = file.installed;
  if (!installed || typeof installed !== "object") {
    if (file.web && typeof file.web === "object")
      throw new Error(m.integrationsGoogleClientFileWeb());
    throw new Error(m.integrationsGoogleClientFileNotJson());
  }
  const { client_id: id, client_secret: secret } = installed as Record<string, unknown>;
  if (typeof id !== "string" || typeof secret !== "string" || !id.trim() || !secret.trim())
    throw new Error(m.integrationsGoogleClientFileIncomplete());
  // Every Google client id ends this way; anything else is another service's file.
  if (!id.trim().endsWith(".apps.googleusercontent.com"))
    throw new Error(m.integrationsGoogleClientFileNotJson());
  return { id: id.trim(), secret: secret.trim() };
}
