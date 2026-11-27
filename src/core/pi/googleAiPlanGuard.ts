import type { Provider } from "@earendil-works/pi-ai";

export const GOOGLE_AI_PLAN_PROVIDER_ID = "google-ai-plan";

/**
 * Infinitary's own google-ai-plan provider: no sign-in and no models.
 *
 * Pi's coding agent adds a built-in google-ai-plan provider to every
 * ModelRuntime it creates, signed in through Pi's own Google OAuth client.
 * Infinitary must never offer a Google sign-in under another app's client,
 * so every runtime registers this in its place right after it is created.
 *
 * Removing Pi's provider does not work: unregisterProvider deletes only
 * registered overrides, and the runtime then composes the provider from its
 * built-ins again, Pi's client included. Only registerNativeProvider shadows
 * a built-in, so the guard is a registered provider, not a removal.
 *
 * Its key auth resolves nothing and has no login, so the provider never
 * reads signed in, and a login asks for a method it does not have.
 */
export function googleAiPlanGuard(): Provider {
  const unavailable = (): never => {
    // i18n-exempt: unreachable, the provider lists no model to stream
    throw new Error("google-ai-plan serves no models.");
  };
  return {
    id: GOOGLE_AI_PLAN_PROVIDER_ID,
    name: GOOGLE_AI_PLAN_PROVIDER_ID,
    auth: {
      apiKey: {
        name: GOOGLE_AI_PLAN_PROVIDER_ID,
        resolve: () => Promise.resolve(undefined),
      },
    },
    getModels: () => [],
    stream: unavailable,
    streamSimple: unavailable,
  };
}
