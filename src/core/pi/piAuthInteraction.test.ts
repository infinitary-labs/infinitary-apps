import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { describe, expect, it } from "vitest";
import type { AuthInteractionBridge } from "./piAuth";
import { buildAuthInteraction } from "./piAuthInteraction";

function bridge(): AuthInteractionBridge & {
  notices: AuthNotice[];
  prompts: AuthPromptView[];
  opened: string[];
  openError?: Error;
} {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  const opened: string[] = [];
  const capture: AuthInteractionBridge & {
    notices: AuthNotice[];
    prompts: AuthPromptView[];
    opened: string[];
    openError?: Error;
  } = {
    notices,
    prompts,
    opened,
    prompt: async (prompt) => {
      prompts.push(prompt);
      return prompt.kind === "select" ? (prompt.options?.[0]?.id ?? "browser") : "code";
    },
    notify: (notice) => {
      notices.push(notice);
    },
    openExternal: async (url) => {
      if (capture.openError) throw capture.openError;
      opened.push(url);
    },
  };
  return capture;
}

describe("buildAuthInteraction", () => {
  it("forwards Codex's login-method select so Connect is not waiting unseen", async () => {
    const capture = bridge();
    const interaction = buildAuthInteraction("openai-codex", "acct_1", capture);
    const answer = await interaction.prompt({
      type: "select",
      message: "Select OpenAI Codex login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });

    expect(answer).toBe("browser");
    expect(capture.prompts[0]).toMatchObject({
      providerId: "openai-codex",
      accountId: "acct_1",
      kind: "select",
      message: "Select OpenAI Codex login method:",
    });
    expect(capture.prompts[0]?.options?.map((option) => option.id)).toEqual([
      "browser",
      "device_code",
    ]);
  });

  it("forwards a manual_code prompt and opens the authorize url", async () => {
    const capture = bridge();
    const interaction = buildAuthInteraction("openai-codex", "acct_1", capture);
    interaction.notify({
      type: "auth_url",
      url: "https://auth.openai.com/oauth/authorize?client_id=app",
      instructions: "A browser window should open. Complete login to finish.",
    });
    await interaction.prompt({
      type: "manual_code",
      message: "Complete login in your browser, or paste the authorization code",
      placeholder: "http://localhost:1455/auth/callback",
    });

    expect(capture.opened).toEqual(["https://auth.openai.com/oauth/authorize?client_id=app"]);
    expect(capture.notices[0]).toMatchObject({
      kind: "auth_url",
      accountId: "acct_1",
      url: "https://auth.openai.com/oauth/authorize?client_id=app",
    });
    expect(capture.prompts[0]).toMatchObject({ kind: "manual_code", accountId: "acct_1" });
  });

  it("cancels a raced prompt when its signal aborts", async () => {
    const hung: AuthInteractionBridge = {
      prompt: () => new Promise(() => {}),
      notify: () => {},
      openExternal: async () => {},
    };
    const interaction = buildAuthInteraction("openai-codex", "acct_1", hung);
    const abort = new AbortController();
    const pending = interaction.prompt({
      type: "manual_code",
      message: "paste",
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});
