import { expect, test } from "@playwright/test";
import { FIRSTMATE_FAILURE_TITLE } from "../../src/core/orchestrator/cardService";
import {
  DEFAULT_LOCAL_ORCHESTRATOR_SETTING,
  localSeatDescription,
} from "../../src/shared/localOrchestrator";
import { startOllamaFixture } from "../fixtures/ollamaServer";
import { nativeCall } from "../helpers/scriptedCalls";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { mockProviderOverrideModelsJson } from "./mockProvider";
import { expectNoCard, shownCard } from "./stack";

test("selecting a base Ollama model creates a hidden alias and serves a visible card", async () => {
  const model = await startOllamaFixture((request) =>
    request.messages.at(-1)?.role === "tool"
      ? { content: "Answered." }
      : {
          thinking: "I should answer on a card.",
          tool_calls: [
            nativeCall("answer-call", {
              name: "emit_card",
              args: {
                id: "arithmetic",
                title: "Four",
                body: "<p>2 + 2 is 4.</p>",
                standalone: true,
              },
            }),
          ],
        },
  );
  const url = `http://127.0.0.1:${model.port}/v1`;
  const app = await launchApp({
    modelsJson: mockProviderOverrideModelsJson,
    env: {
      INFINITARY_LOCAL_ORCHESTRATOR_URL: url,
      INFINITARY_LOCAL_ORCHESTRATOR_MODEL: "fixture",
    },
  });
  try {
    const input = app.page.getByRole("textbox", { name: "Task prompt" });
    await input.fill("what is 2 + 2?");
    await input.press("Enter");
    await expect(cardBody(app.page, "Four").getByText("2 + 2 is 4.")).toBeVisible();
    expect(model.aliases.size).toBe(1);
    expect(
      model.requests.every(
        (r) => model.aliases.has(r.model) && r.truncate === false && r.shift === false,
      ),
    ).toBe(true);
    expect(model.requests[0]?.tools?.some((tool) => tool.function.name === "emit_card")).toBe(true);
    await expectNoCard(app.page, FIRSTMATE_FAILURE_TITLE);
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("tab", { name: "General", exact: true }).click();
    await expect(app.page.locator("[data-local-seat]")).toContainText(
      localSeatDescription({
        available: true,
        setting: DEFAULT_LOCAL_ORCHESTRATOR_SETTING,
        active: { model: "fixture", host: new URL(url).host, source: "environment" },
        problem: null,
      }),
    );
    await expect(app.page.locator("body")).not.toContainText("fm3000-context-");
  } finally {
    await app.close();
    await model.close();
  }
});

test("Retry replays the ask, and a successful operation needs no answer card", async () => {
  let phase: "fail" | "answer" | "operate" = "fail";
  const model = await startOllamaFixture((request) => {
    if (phase === "fail") return { content: "4." };
    if (request.messages.at(-1)?.role === "tool") return { content: "Done." };
    return {
      tool_calls: [
        nativeCall(
          `call-${phase}`,
          phase === "answer"
            ? { name: "emit_card", args: { title: "Four", body: "<p>4</p>", standalone: true } }
            : {
                name: "app_change",
                args: {
                  action: "theme",
                  value: { theme: "light" },
                  evidence: "switch to the light theme",
                },
              },
        ),
      ],
    };
  });
  const app = await launchApp({
    modelsJson: mockProviderOverrideModelsJson,
    env: {
      INFINITARY_LOCAL_ORCHESTRATOR_URL: `http://127.0.0.1:${model.port}/v1`,
      INFINITARY_LOCAL_ORCHESTRATOR_MODEL: "fixture",
    },
  });
  try {
    const input = app.page.getByRole("textbox", { name: "Task prompt" });
    await input.fill("what is 2 + 2?");
    await input.press("Enter");
    await expect(shownCard(app.page, FIRSTMATE_FAILURE_TITLE)).toBeVisible();
    phase = "answer";
    await app.page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(cardBody(app.page, "Four").getByText("4", { exact: true })).toBeVisible();
    // The answer card hides the Firstmate's frame; its turn has still ended.
    await waitForFirstmateIdle(app.page);
    await expectNoCard(app.page, FIRSTMATE_FAILURE_TITLE);
    await app.page.getByRole("button", { name: "Close", exact: true }).click();
    phase = "operate";
    await askFirstmate(app.page, "switch to the light theme");
    await expect(app.page.locator("body")).toHaveAttribute("data-theme", "light");
    await expect(app.page.locator("[data-card-layer]")).toHaveCount(0);
    expect(model.aliases.size).toBe(1);
  } finally {
    await app.close();
    await model.close();
  }
});

for (const mode of [
  "creation",
  "no-answer",
  "thinking-only",
  "parser",
  "refused-card",
  "bad-action",
  "length",
  "overflow",
] as const) {
  test(`a local ${mode} failure is a visible retry card, not a silent turn`, async () => {
    const model = await startOllamaFixture((request) => {
      if (mode === "length") return { thinking: "unfinished", reason: "length" };
      if (mode === "overflow") return { error: "context_length_exceeded: input too long" };
      if (mode === "thinking-only") return { thinking: "The answer is four." };
      if (mode === "parser")
        return { error: "XML syntax error on line 12: element <parameter> closed by </function>" };
      if (mode === "refused-card" && request.messages.at(-1)?.role !== "tool")
        return {
          tool_calls: [
            nativeCall("bad-card", {
              name: "emit_card",
              args: { title: "Four", body: "<p>4</p>" },
            }),
          ],
        };
      if (mode === "bad-action" && request.messages.at(-1)?.role !== "tool")
        return {
          tool_calls: [
            nativeCall("bad-steer", {
              name: "steer_crewmate",
              args: { task_id: "missing", message: "go" },
            }),
          ],
        };
      return { content: "4." };
    });
    if (mode === "creation") model.denyCreate();
    const app = await launchApp({
      modelsJson: mockProviderOverrideModelsJson,
      env: {
        INFINITARY_LOCAL_ORCHESTRATOR_URL: `http://127.0.0.1:${model.port}/v1`,
        INFINITARY_LOCAL_ORCHESTRATOR_MODEL: "fixture",
      },
    });
    try {
      const input = app.page.getByRole("textbox", { name: "Task prompt" });
      await input.fill("what is 2 + 2?");
      await input.press("Enter");
      await expect(shownCard(app.page, FIRSTMATE_FAILURE_TITLE)).toBeVisible();
      await expect(app.page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      const body = cardBody(app.page, FIRSTMATE_FAILURE_TITLE);
      await expect(body.locator("body")).toContainText(
        mode === "creation"
          ? "prepare the local model"
          : mode === "length"
            ? "ran out of room"
            : mode === "overflow"
              ? "could not shorten"
              : mode === "parser"
                ? "unreadable action"
                : "without showing an answer",
      );
      await expect(body.locator("body")).not.toContainText("fm3000-context-");
    } finally {
      await app.close();
      await model.close();
    }
  });
}
