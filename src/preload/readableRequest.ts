import { COMPUTER, HERE } from "@shared/deviceNames";
import { ZodError } from "zod";

// Only requests whose caught rejection is shown directly to the captain.
// Other channels retain their existing error contract.
export const REQUEST_COPY = {
  "inf:models:speed:set": { fallback: "Could not save crew speed. Please try again.", prefix: "" },
  "inf:models:reasoning:set": {
    fallback: "Could not save reasoning. Please try again.",
    prefix: "",
  },
  "inf:automation:save": {
    fallback: "Could not save this automation. Please try again.",
    prefix: "",
  },
  "inf:automation:state": {
    fallback: "Could not change this automation. Please try again.",
    prefix: "",
  },
  "inf:repos:remove": { fallback: "Could not remove this project. Please try again.", prefix: "" },
  "inf:repos:configure": {
    fallback: "Could not save this project change. Please try again.",
    prefix: "",
  },
  "inf:repos:setup": { fallback: "Could not add this project. Please try again.", prefix: "" },
  "inf:forges:projects": { fallback: "Could not read your repos. Please try again.", prefix: "" },
  "inf:accounts:custom:review": {
    fallback: "Could not review this server address. Please try again.",
    prefix: "Could not review this server address: ",
  },
  "inf:accounts:custom:connect": {
    fallback: "Could not reach this server. Please try again.",
    prefix: "Could not reach this server: ",
  },
  "inf:accounts:custom:prepare": {
    fallback: "Could not prepare this connection.",
    prefix: "Could not prepare this connection: ",
  },
  "inf:accounts:custom:check": {
    fallback: "Could not check this model.",
    prefix: "Could not check this model: ",
  },
  "inf:accounts:custom:discover": {
    fallback: "Could not read this server's model list. You can enter models manually.",
    prefix: "Could not read this server's model list: ",
  },
  "inf:accounts:custom:save": {
    fallback: "Could not save this connection.",
    prefix: "Could not save this connection: ",
  },
  "inf:accounts:custom:recheck": {
    fallback: "Could not check this connection. Please try again.",
    prefix: "Could not check this connection: ",
  },
  "inf:devices:custom:review": {
    fallback: "Could not review this server address. Please try again.",
    prefix: "Could not review this server address: ",
  },
  "inf:devices:custom:connect": {
    fallback: "Could not reach this server. Please try again.",
    prefix: "Could not reach this server: ",
  },
  "inf:devices:custom:check": {
    fallback: "Could not check this model.",
    prefix: "Could not check this model: ",
  },
  "inf:devices:custom:discover": {
    fallback: "Could not read this server's model list. You can enter models manually.",
    prefix: "Could not read this server's model list: ",
  },
  "inf:devices:custom:save": {
    fallback: "Could not save this connection.",
    prefix: "Could not save this connection: ",
  },
  "inf:devices:custom:recheck": {
    fallback: "Could not check this connection. Please try again.",
    prefix: "Could not check this connection: ",
  },
  "inf:cards:act": { fallback: "Could not use this choice. Please try again.", prefix: "" },
  "inf:cards:reply": { fallback: "Could not send this reply. Please try again.", prefix: "" },
  "inf:quota:refresh": {
    fallback: "Could not refresh your plan's allowance. Please try again.",
    prefix: "Could not refresh your plan's allowance: ",
  },
  "inf:models:slots": {
    fallback: "Could not load models. Please try again.",
    prefix: "Could not load models: ",
  },
  "inf:accounts:add": {
    fallback: "Could not add this account. Please try again.",
    prefix: "Could not add this account: ",
  },
  "inf:accounts:sign-in": {
    fallback: "Could not sign in to this account. Please try again.",
    prefix: "Could not sign in to this account: ",
  },
  "inf:settings:routing:set": {
    fallback: "Could not save routing. Please try again.",
    prefix: "Could not save routing: ",
  },
  "inf:settings:firstmate-account:set": {
    fallback: "Could not change Firstmate's account. Please try again.",
    prefix: "Could not change Firstmate's account: ",
  },
  "inf:devices:invite": { fallback: "Could not make a link. Please try again.", prefix: "" },
  "inf:devices:remove": { fallback: "Could not remove this device. Please try again.", prefix: "" },
  "inf:devices:add": {
    fallback: `Could not add this ${COMPUTER.one}. Please try again.`,
    prefix: "",
  },
  "inf:devices:try-again": { fallback: "Could not try again. Please try again.", prefix: "" },
  "inf:devices:change-address": {
    fallback: `Could not change where this ${COMPUTER.one} is reached. Please try again.`,
    prefix: "",
  },
  "inf:devices:update": {
    fallback: `Could not update Firstmate on this ${COMPUTER.one}. Please try again.`,
    prefix: "",
  },
  "inf:devices:runs-on": {
    fallback: "Could not change where this project runs. Please try again.",
    prefix: "",
  },
  "inf:devices:address:set": {
    fallback: `Could not change where devices find ${HERE.this}. Please try again.`,
    prefix: "",
  },
  "inf:repos:folder:set": {
    fallback: "Could not change where new projects go. Please try again.",
    prefix: "",
  },
  "inf:settings:firstmate-model:set": {
    fallback: "Could not change Firstmate's model. Please try again.",
    prefix: "Could not change Firstmate's model: ",
  },
  "inf:settings:appearance:set": {
    fallback: "Could not save this setting. Please try again.",
    prefix: "Could not save this setting: ",
  },
  "inf:settings:panels:set": {
    fallback: "Could not change your panels. Please try again.",
    prefix: "Could not change your panels: ",
  },
  "inf:settings:sharing:set": {
    fallback: "Could not change sharing. Please try again.",
    prefix: "Could not change sharing: ",
  },
  "inf:settings:sharing:viewed": {
    fallback: "Could not save your answer. Please try again.",
    prefix: "Could not save your answer: ",
  },
  "inf:settings:sharing:ask": {
    fallback: "Could not save your answer. Please try again.",
    prefix: "Could not save your answer: ",
  },
  "inf:accounts:list": {
    fallback: "Could not read your accounts. Please try again.",
    prefix: "Could not read your accounts: ",
  },
  "inf:accounts:rename": {
    fallback: "Could not rename this account. Please try again.",
    prefix: "Could not rename this account: ",
  },
  "inf:accounts:pin": {
    fallback: "Could not change which account crew work prefers. Please try again.",
    prefix: "Could not change which account crew work prefers: ",
  },
  "inf:accounts:set-enabled": {
    fallback: "Could not pause or resume this account. Please try again.",
    prefix: "Could not pause or resume this account: ",
  },
  "inf:accounts:remove": {
    fallback: "Could not disconnect this account. Please try again.",
    prefix: "Could not disconnect this account: ",
  },
  "inf:settings:dictation:set": {
    fallback: "Could not save dictation. Please try again.",
    prefix: "Could not save dictation: ",
  },
  "inf:settings:personal-resources:set": {
    fallback: "Could not save your instructions and skills setting. Please try again.",
    prefix: "",
  },
  "inf:settings:notifications:set": {
    fallback: "Could not save notifications. Please try again.",
    prefix: "Could not save notifications: ",
  },
  "inf:presence:set": {
    fallback: "Could not save start-at-login and dock settings. Please try again.",
    prefix: "Could not save start-at-login and dock settings: ",
  },
  "inf:models:slots:set": {
    fallback: "Could not save model slots. Please try again.",
    prefix: "Could not save model slots: ",
  },
  "inf:models:slots:reset": {
    fallback: "Could not reset model slots. Please try again.",
    prefix: "Could not reset model slots: ",
  },
  "inf:settings:decisions:set": {
    fallback: "Could not save the decision model. Please try again.",
    prefix: "Could not save the decision model: ",
  },
  "inf:decisions:key:set": {
    fallback: "Could not save the decision model key. Please try again.",
    prefix: "Could not save the decision model key: ",
  },
  "inf:decisions:key:remove": {
    fallback: "Could not remove the decision model key. Please try again.",
    prefix: "Could not remove the decision model key: ",
  },
  "inf:retention:purge": {
    fallback: "Purge did not complete. Please try again.",
    prefix: "Purge did not complete: ",
  },
  "inf:retention:delete-outside": {
    fallback: "Could not delete it. Please try again.",
    prefix: "Could not delete it: ",
  },
  "inf:keyboard:save": {
    fallback: "Could not save these keys. Please try again.",
    prefix: "Could not save these keys: ",
  },
  // The binding's own words already say why the server could not connect.
  "inf:integrations:add": { fallback: "Could not add this server. Please try again.", prefix: "" },
  // The binding's own words already say why the sign-in did not finish.
  "inf:integrations:sign-in": { fallback: "Could not sign in. Please try again.", prefix: "" },
} as const;

type ReadableRequestChannel = keyof typeof REQUEST_COPY;

/**
 * Electron wraps a rejected invoke in its remote method name and the thrown
 * error's class. That syntax belongs to the transport, not the explanation.
 * Keep the reason, without teaching the shell to parse transport messages.
 * Settings failures also name the operation that failed.
 * Unknown/empty failures get a readable fallback rather than an object dump.
 */
export async function readableRequest<T>(
  channel: ReadableRequestChannel,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (caught) {
    let message = caught instanceof Error ? caught.message.trim() : "";
    const wrapper = `Error invoking remote method '${channel}': `;
    if (message.startsWith(wrapper)) {
      message = message.slice(wrapper.length);
      // Contract failures are diagnostic data, not a refusal explanation.
      if (message.startsWith("ZodError:")) message = "";
      // An Error with no message crosses Electron as just its class name,
      // without a colon. It is still decoration, not a useful reason.
      else message = message.replace(/^(?:Error|[A-Za-z]+Error)(?::(?:\s+|$)|$)/, "").trim();
    }
    if (caught instanceof ZodError) message = "";
    // A different or incomplete transport wrapper is not a refusal reason.
    if (
      !message ||
      message === "[object Object]" ||
      message === "null" ||
      message === "undefined" ||
      message.startsWith("Error invoking remote method") ||
      message.startsWith("No handler registered for '")
    ) {
      throw new Error(REQUEST_COPY[channel].fallback);
    }
    throw new Error(REQUEST_COPY[channel].prefix + message);
  }
}
