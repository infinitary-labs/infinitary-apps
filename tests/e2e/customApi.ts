import { expect, type Locator, type Page } from "@playwright/test";
import { type CustomNetworkMode, customNetworkLabel } from "@shared/customApi";
import { CUSTOM_EXCEPTION_WORDS } from "../../src/renderer/src/accounts/customApiFailures";

/**
 * The custom API dialog as a person works it, wherever it opened: Add from
 * Intelligence or first setup, or Edit from a connection's block. The one
 * home of how a journey reaches into it, so a redesign of the form is
 * repaired here and not in every journey that connects a server.
 */
export function customApiForm(page: Page) {
  const form = page.locator("[data-custom-api-form]");
  const row = (id: string) => form.locator(`[data-custom-model-row="${id}"]`);
  return {
    form,
    name: form.getByLabel("Name", { exact: true }),
    address: form.getByLabel("Address", { exact: true }),
    /** The live line under the address: where Save sends, and the network read from it. */
    sendsTo: form.locator("[data-custom-sends-to]"),
    http: form.getByLabel(/^Send over unencrypted HTTP/),
    /** The live sentence saying what DNS answered for a refused name. */
    answers: form.locator("[data-custom-answers]"),
    /** The person's exception for that one address, offered under it. */
    exception: form.getByLabel(/^Make an exception for /),
    key: form.getByLabel(/^API key/),
    authentication: form.getByLabel("Connect with", { exact: true }),
    commandApproval: form.locator("[data-custom-command-approval] pre"),
    tokenCommand: form.getByLabel("Token command", { exact: true }),
    refreshSeconds: form.getByLabel("Refresh after (seconds)", { exact: true }),
    protocol: form.getByLabel("API protocol"),
    fetch: form.getByRole("button", { name: /^Fetch (from server|again)$/ }),
    listed: (id: string) => form.locator(`[data-custom-listed="${id}"]`),
    row,
    /** A model line's folded name and prices. */
    price: (id: string) => {
      const part = row(id).locator("[data-custom-price]");
      return {
        open: part.locator("summary"),
        name: part.getByLabel("Display name", { exact: true }),
        input: part.getByLabel("Input", { exact: true }),
        output: part.getByLabel("Output", { exact: true }),
        free: part.getByLabel("Free", { exact: true }),
      };
    },
    /** The words a failed check left on a model's row. */
    rowError: (id: string) => row(id).getByRole("alert"),
    /** The words a failure left beside a field: `address`, `http`, `key`, `headers`, `save`... */
    error: (field: string) => form.locator(`[data-custom-error="${field}"]`),
    /** The one-press address a failure offers, such as the same one ending in /v1. */
    fix: form.locator('[data-custom-error="address"]').getByRole("button", { name: /^Use / }),
    addByHand: form.getByRole("button", { name: "+ Add by hand", exact: true }),
    save: form.getByRole("button", { name: "Save", exact: true }),
    savePaused: form.getByRole("button", { name: "Save paused without checking", exact: true }),
    /** First setup's question once a connection is saved and ready. */
    choose: page.locator("[data-custom-choose]"),
  };
}

export type CustomApiEntry = {
  name: string;
  address: string;
  /** Waits for the line under the address to read this network. */
  network?: CustomNetworkMode;
  /** The computer the form names in that line. Absent, this Mac. */
  who?: string;
  /** Typed into the optional key field; left out, the server gets no key. */
  key?: string;
  protocol?: "openai-completions" | "openai-responses";
  /** Fetched from the server and picked, in order. */
  pick?: string[];
  /** Added by hand; a size left out stays blank for the server's list or Save's check. */
  models?: { id: string; context?: number; output?: number }[];
};

/** Fills the dialog the way a person would; a plain-HTTP address gets its approval ticked. */
export async function fillCustomApi(page: Page, entry: CustomApiEntry): Promise<void> {
  const f = customApiForm(page);
  await f.name.fill(entry.name);
  await f.address.fill(entry.address);
  if (entry.network)
    await expect(f.sendsTo).toContainText(customNetworkLabel(entry.network, entry.who));
  if (/^http:\/\//i.test(entry.address)) await f.http.check();
  if (entry.key !== undefined) await f.key.fill(entry.key);
  if (entry.protocol) await f.protocol.selectOption(entry.protocol);
  if (entry.pick?.length) {
    await f.fetch.click();
    for (const id of entry.pick) await f.listed(id).click();
  }
  for (const model of entry.models ?? []) {
    await f.addByHand.click();
    const row = f.form.locator("[data-custom-model-row]").last();
    await row.getByLabel("Model ID", { exact: true }).fill(model.id);
    if (model.context) await row.getByLabel(/^Context tokens/).fill(String(model.context));
    if (model.output) await row.getByLabel(/^Output tokens/).fill(String(model.output));
  }
}

/**
 * Presses Save and waits for what it came to: `saved` when the dialog closed
 * or first setup asks which model Firstmate uses, `failed` when the form
 * stayed open with its failure beside the field at fault.
 */
export async function saveCustomApi(page: Page): Promise<"saved" | "failed"> {
  const f = customApiForm(page);
  await f.save.click();
  const outcome = async () => {
    if ((await f.choose.count()) > 0 || (await f.form.count()) === 0) return "saved";
    if ((await f.form.locator("[data-custom-summary]").count()) > 0) return "failed";
    return "pending";
  };
  await expect.poll(outcome, { timeout: 60_000 }).not.toBe("pending");
  return (await outcome()) === "saved" ? "saved" : "failed";
}

/** A connection's block in Settings → Intelligence. */
export function customApiBlock(page: Page, accountId: string) {
  const block = page.locator(`[data-custom-account="${accountId}"]`);
  return {
    block,
    edit: block.getByRole("button", { name: "Edit", exact: true }),
    resume: block.getByRole("button", { name: "Resume", exact: true }),
    unencrypted: block.getByText("Unencrypted", { exact: true }),
    exception: block.getByText(CUSTOM_EXCEPTION_WORDS.tag, { exact: true }),
    firstmate: (model: string) =>
      block.getByRole("radio", { name: `Use ${model} for your first mate`, exact: true }),
  };
}

export function customApiEditDialog(page: Page, name: string): Locator {
  return page.getByRole("dialog", { name: `Edit ${name}`, exact: true });
}
