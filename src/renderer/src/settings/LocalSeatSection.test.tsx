import { type LocalOrchestratorView, localSeatDescription } from "@shared/localOrchestrator";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalSeatSectionView } from "./LocalSeatSection";

/**
 * The dev-only local seat's Settings section (roadmap 1.7): nothing at all
 * unless the core says the control is available - a packaged build never
 * does - and, available, a switch plus the endpoint and model fields whose
 * one line says what the seat is doing.
 */

const OFF: LocalOrchestratorView = {
  available: true,
  setting: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "" },
  active: null,
  problem: null,
};

const noop = () => {};

function render(view: LocalOrchestratorView | null) {
  return renderToStaticMarkup(
    <LocalSeatSectionView
      view={view}
      draft={view?.setting ?? OFF.setting}
      onToggle={noop}
      onDraft={noop}
      onCommit={noop}
    />,
  );
}

describe("LocalSeatSectionView", () => {
  it("renders nothing while the view is unknown or the control is unavailable", () => {
    expect(render(null)).toBe("");
    expect(render({ ...OFF, available: false })).toBe("");
  });

  it("renders the switch and the two fields when the core offers the control", () => {
    const markup = render(OFF);
    expect(markup).toContain('data-setting="local-seat"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('aria-label="Local endpoint"');
    expect(markup).toContain('value="http://localhost:11434/v1"');
    expect(markup).toContain('aria-label="Local model"');
    expect(markup).toContain("Local model (dev checkout)");
  });
});

describe("localSeatDescription", () => {
  it("says where the seat is, who asked for it, or why the row seats nothing", () => {
    expect(localSeatDescription(OFF)).toMatch(/^Only this dev checkout/);
    expect(
      localSeatDescription({
        ...OFF,
        setting: { enabled: true, baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
        active: { model: "qwen3:8b", host: "localhost:11434", source: "setting" },
      }),
    ).toBe(
      "Your first mate runs on qwen3:8b at localhost:11434; crewmates route as usual. A change binds at the next idle moment.",
    );
    expect(
      localSeatDescription({
        ...OFF,
        active: { model: "gemma4:12b", host: "127.0.0.1:11434", source: "environment" },
      }),
    ).toBe(
      "Set by the environment for this run: gemma4:12b at 127.0.0.1:11434. Turn this on to use the fields below instead.",
    );
    expect(
      localSeatDescription({
        ...OFF,
        setting: { enabled: true, baseUrl: "ollama", model: "" },
        problem: "The endpoint must be an http(s) URL, such as http://localhost:11434/v1.",
      }),
    ).toBe("The endpoint must be an http(s) URL, such as http://localhost:11434/v1.");
  });
});
