import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthNotice } from "@shared/providers";
import type { AuthInteractionBridge } from "./piAuth";

export type AuthInteractionOptions = {
  /**
   * Opening the browser failed. The login must reject; swallowing this is
   * what left Connect stuck on "Connecting..." with no follow-up.
   */
  onFatal?: (error: Error) => void;
  /**
   * Answers a prompt the app already knows the answer to, so it never
   * reaches the person: undefined lets it through.
   */
  answer?: (prompt: { type: string }) => string | undefined;
};

/**
 * Maps Pi's login interaction onto the app's AuthInteractionBridge, tagging
 * every prompt and notice with the account it belongs to so the renderer
 * can route them to the right row.
 *
 * Codex's first step is a select (browser vs device code). That prompt has
 * to reach the UI; if it does not, login waits forever and the button hangs.
 */
export function buildAuthInteraction(
  providerId: string,
  accountId: string,
  bridge: AuthInteractionBridge,
  options: AuthInteractionOptions = {},
): Parameters<ModelRuntime["login"]>[2] {
  return {
    prompt: async (prompt) => {
      const known = options.answer?.(prompt);
      if (known !== undefined) return known;
      const reply = bridge.prompt({
        promptId: randomUUID(),
        providerId,
        accountId,
        kind: prompt.type,
        message: prompt.message,
        ...("placeholder" in prompt && prompt.placeholder
          ? { placeholder: prompt.placeholder }
          : {}),
        ...(prompt.type === "select" ? { options: [...prompt.options] } : {}),
      });
      if (!prompt.signal) return reply;
      if (prompt.signal.aborted) throw new Error("Sign in cancelled");
      return new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(new Error("Sign in cancelled"));
        prompt.signal?.addEventListener("abort", onAbort, { once: true });
        void reply.then(resolve, reject).finally(() => {
          prompt.signal?.removeEventListener("abort", onAbort);
        });
      });
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        const opening = bridge.openExternal(event.url);
        bridge.notify({
          providerId,
          accountId,
          kind: "auth_url",
          message: event.instructions ?? "Finish signing in with your browser.",
          url: event.url,
        });
        void opening.catch((caught) => {
          options.onFatal?.(
            caught instanceof Error ? caught : new Error("Could not open the sign-in page."),
          );
        });
        return;
      }
      if (event.type === "device_code") {
        bridge.notify({
          providerId,
          accountId,
          kind: "device_code",
          message: `Enter code at ${event.verificationUri}`,
          url: event.verificationUri,
          userCode: event.userCode,
          ...(typeof event.expiresInSeconds === "number"
            ? { expiresAt: Date.now() + event.expiresInSeconds * 1000 }
            : {}),
        });
        return;
      }
      bridge.notify({
        providerId,
        accountId,
        kind: event.type,
        message: event.message,
      } as AuthNotice);
    },
  };
}
