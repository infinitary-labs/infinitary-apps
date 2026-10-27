import { createServer } from "node:http";
import type { Page } from "@playwright/test";
import { readSavedData } from "../../e2e/savedData";
import {
  chatFrame,
  customChatCall,
  customChatText,
  sendCustomStream,
} from "../../helpers/customApiDialect";

const prompt = "Keep working on the installation guide while I update Infinitary.";
const modelId = "installer-verification";

/** INF-640: a real streamed turn must stop before native replacement, retaining the captain's message. */
export async function runningWorkFixture(
  installedVersion: () => string,
  note: (phase: string) => void = () => {},
) {
  let phase = "Not started";
  let started = false;
  let closedAtVersion: string | undefined;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    if (raw.includes("synthetic API connection check")) {
      sendCustomStream(
        response,
        raw.includes('"role":"tool"')
          ? customChatText("FIRSTMATE_CUSTOM_API_OK")
          : customChatCall("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}'),
      );
      return;
    }
    if (!raw.includes(prompt)) {
      sendCustomStream(response, customChatText("Ready."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(
      chatFrame({ role: "assistant", content: "I am working on the installation guide." }),
    );
    started = true;
    response.on("close", () => {
      closedAtVersion ??= installedVersion();
    });
    // Keep the actual provider stream open until the application aborts it during shutdown.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The isolated model did not listen.");
  return {
    get phase() {
      return phase;
    },
    get started() {
      return started;
    },
    get closedAtVersion() {
      return closedAtVersion;
    },
    async start(page: Page) {
      await page.exposeFunction("__installerWorkPhase", (next: string) => {
        phase = next;
        note(next);
      });
      await page.evaluate(
        async ({ baseUrl, modelId, prompt }) => {
          const checkpoint = (next: string) =>
            (
              window as unknown as { __installerWorkPhase: (next: string) => Promise<void> }
            ).__installerWorkPhase(next);
          const api = window.infinitary;
          await checkpoint("Reviewing the local connection");
          const review = await api.accounts.custom.review(baseUrl, "local");
          await checkpoint("Preparing the local connection");
          const draft = await api.accounts.custom.prepare({
            label: "Installer verification",
            baseUrl,
            mode: "local",
            protocol: "openai-completions",
            key: "",
            noKey: true,
            headers: [],
            approvedDestination: review.destination,
            unencryptedLocalApproved: true,
            allowStorageDefault: false,
            storageApproved: false,
            models: [{ id: modelId, context: 1048576, output: 4096 }],
          });
          if (!draft.draftId) throw new Error("The isolated connection has no draft.");
          await checkpoint("Checking the local model");
          const checked = await api.accounts.custom.check(draft.draftId, modelId);
          if (!checked.models.find((model) => model.id === modelId)?.checked)
            throw new Error("The isolated connection did not pass its check.");
          await checkpoint("Saving the local connection");
          const saved = await api.accounts.custom.save(draft.draftId, false);
          if (!saved.accountId) throw new Error("The isolated connection did not save.");
          await checkpoint("Reading the available models");
          const model = (await api.models.available()).find((model) => model.id === modelId);
          if (!model) throw new Error("The isolated model is not available.");
          await checkpoint("Choosing the local model");
          await api.settings.setFirstmateModel(model);
          await checkpoint("Choosing the local account");
          await api.settings.setFirstmateAccount(saved.accountId);
          await checkpoint("Submitting the active-work message");
          await api.conversation.send(prompt);
          await checkpoint("Active-work message accepted");
        },
        { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId, prompt },
      );
    },
    messageSurvived(root: string): boolean {
      return Boolean(
        readSavedData(root, (db) =>
          db.prepare("SELECT id FROM captain_asks WHERE text = ?").get(prompt),
        ),
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
