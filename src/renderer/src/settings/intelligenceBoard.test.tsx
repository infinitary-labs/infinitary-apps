import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FirstmateModelRow,
  FirstmateModelSelect,
  firstmateModelByName,
  firstmateModelChoices,
  firstmateModelOptionLabel,
  firstmatePinIsOffered,
  firstmateSeatDescription,
  nextFirstmateModel,
} from "./GeneralTab";
import { FirstmateAccountSelect } from "./SubscriptionsTab";

describe("Firstmate model options", () => {
  it("names the catalog provider, never the machinery id", () => {
    const claude = { provider: "anthropic-claude", id: "opus" };
    expect(firstmateModelOptionLabel(claude)).toBe("Claude · opus");
    expect(firstmateModelOptionLabel(claude)).not.toMatch(/anthropic-claude/i);
    expect(firstmateModelOptionLabel({ provider: "openai-codex", id: "gpt-5.5" })).toBe(
      "Codex · gpt-5.5",
    );
  });

  it("offers Claude beside the Pi providers, omits retired ones, keeps custom ones from models.json", () => {
    expect(
      firstmateModelChoices([
        { provider: "anthropic-claude", id: "opus" },
        // A leftover from a provider this build no longer offers.
        { provider: "cursor", id: "composer" },
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "fm-mock", id: "mock-1" },
      ]),
    ).toEqual([
      { provider: "anthropic-claude", id: "opus" },
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "fm-mock", id: "mock-1" },
    ]);
  });

  it("offers a custom-provider pin without the cannot-run verdict", () => {
    const pin = { provider: "fm-mock", id: "mock-1" };
    const available = [pin, { provider: "openai-codex", id: "gpt-5.5" }];
    const choices = firstmateModelChoices(available);
    expect(firstmatePinIsOffered(pin, choices)).toBe(true);
    expect(nextFirstmateModel("fm-mock/mock-1", pin, choices)).toEqual(pin);

    const html = renderToStaticMarkup(
      <FirstmateModelSelect chosen={pin} available={available} onChange={() => {}} />,
    );
    expect(html).toContain('value="fm-mock/mock-1"');
    expect(html).not.toContain("cannot run your first mate");
  });

  it("renders a pin plainly while the model list is loading, then judges it", () => {
    const pin = { provider: "openai-codex", id: "gpt-5.5" };
    const loading = renderToStaticMarkup(
      <FirstmateModelSelect chosen={pin} available={null} onChange={() => {}} />,
    );
    expect(loading).toContain('value="openai-codex/gpt-5.5"');
    expect(loading).toContain("Codex · gpt-5.5");
    expect(loading).not.toContain("cannot run your first mate");

    const loaded = renderToStaticMarkup(
      <FirstmateModelSelect chosen={pin} available={[pin]} onChange={() => {}} />,
    );
    expect(loaded).not.toContain("cannot run your first mate");

    const judged = renderToStaticMarkup(
      <FirstmateModelSelect
        chosen={{ provider: "anthropic-claude", id: "claude-sonnet-5" }}
        available={[pin]}
        onChange={() => {}}
      />,
    );
    expect(judged).toContain("cannot run your first mate");
  });

  it("keeps a stranded pin visible and Auto clears it", () => {
    // A pin on a provider this build no longer offers.
    const pin = { provider: "cursor", id: "composer" };
    const offered = { provider: "openai-codex", id: "gpt-5.5" };
    const available = [pin, offered];
    const choices = firstmateModelChoices(available);
    expect(firstmatePinIsOffered(pin, choices)).toBe(false);
    expect(nextFirstmateModel("", pin, choices)).toBeNull();
    expect(nextFirstmateModel("cursor/composer", pin, choices)).toEqual(pin);
    expect(nextFirstmateModel("openai-codex/gpt-5.5", pin, choices)).toEqual(offered);

    const html = renderToStaticMarkup(
      <FirstmateModelSelect chosen={pin} available={available} onChange={() => {}} />,
    );
    expect(html).toContain('value="cursor/composer"');
    expect(html).toContain("cannot run your first mate");
  });
});

describe("the Firstmate picker's by-name path (docs/model-lists.md)", () => {
  const listed = { provider: "openai-codex", id: "gpt-6-sol" };
  const unlisted = [
    { provider: "openai-codex", id: "gpt-5.6-sol", label: "Codex · GPT-5.6 Sol" },
    // A provider this build no longer offers: it runs no Firstmate.
    { provider: "cursor", id: "composer-2", label: "cursor · composer-2" },
  ];

  it("offers another model by name only when a Firstmate-capable one is unlisted", () => {
    const html = renderToStaticMarkup(
      <FirstmateModelSelect
        chosen={null}
        available={[listed]}
        byName={unlisted}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Another model by name…");
    // Unlisted models are never options of their own.
    expect(html).not.toContain("gpt-5.6-sol");
    const retired = renderToStaticMarkup(
      <FirstmateModelSelect
        chosen={null}
        available={[listed]}
        byName={[unlisted[1] as (typeof unlisted)[number]]}
        onChange={() => {}}
      />,
    );
    expect(retired).not.toContain("Another model by name…");
  });

  it("sets only a name some subscription serves", () => {
    expect(firstmateModelByName(" openai-codex/gpt-5.6-sol ", unlisted)).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    });
    expect(firstmateModelByName("openai-codex/gpt-9", unlisted)).toBeNull();
  });

  it("shows a pin chosen by name as itself, not as one that cannot run", () => {
    const html = renderToStaticMarkup(
      <FirstmateModelSelect
        chosen={{ provider: "openai-codex", id: "gpt-5.6-sol" }}
        available={[listed]}
        byName={unlisted}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('value="openai-codex/gpt-5.6-sol"');
    expect(html).not.toContain("cannot run your first mate");
  });
});

describe("Firstmate account picker", () => {
  const choices = [
    { id: "acct_cx1", label: "Personal" },
    { id: "acct_cx2", label: "Work" },
    { id: "acct_cx3", label: "Old team", unavailable: "paused" },
  ];
  const select = (chosen: string | null) => (
    <FirstmateAccountSelect choices={choices} chosen={chosen} saving={false} onChoose={() => {}} />
  );
  const render = (chosen: string | null) => renderToStaticMarkup(select(chosen));

  it("sits beside the model's dropdown in the one Firstmate row, which names both", () => {
    const html = renderToStaticMarkup(
      <FirstmateModelRow
        account={{ providerName: "Codex", error: null, select: select("acct_cx1") }}
      />,
    );
    // One row: one setting hook, holding both dropdowns, model first.
    expect(html.match(/data-setting="/g)).toHaveLength(1);
    expect(html).toContain('data-setting="firstmate-model"');
    expect(html.indexOf('aria-label="First mate model"')).toBeLessThan(
      html.indexOf('aria-label="First mate account"'),
    );
    expect(html).toContain("First mate model and account");
    expect(html).toContain("and the Codex account it answers on");
    expect(html).toContain("crew work keeps its own preferred account");
    expect(html).toContain("a change applies at the next idle moment");
  });

  it("keeps the model row as it was when there is no account to choose", () => {
    const html = renderToStaticMarkup(<FirstmateModelRow />);
    expect(html).not.toContain('aria-label="First mate account"');
    expect(html).not.toContain("First mate model and account");
    expect(firstmateSeatDescription()).toBe(
      "The model your first mate itself answers with. Auto tries your models for hard tasks, then normal, premium, then simple, across your subscriptions; a change applies at the next idle moment.",
    );
  });

  it("shows a refused pick in the row", () => {
    const html = renderToStaticMarkup(
      <FirstmateModelRow
        account={{
          providerName: "Codex",
          error: "Could not change your first mate's account: Work is paused.",
          select: select("acct_cx1"),
        }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Work is paused.");
  });

  it("shows the account Firstmate answers on, by the captain's label, never its id", () => {
    const html = render("acct_cx2");
    expect(html).toMatch(/<option value="acct_cx2" selected="">Work<\/option>/);
    expect(html).toContain(">Personal</option>");
    expect(html).not.toMatch(/>acct_/);
  });

  it("lists an account that cannot run Firstmate with why, and never lets it be picked", () => {
    const html = render("acct_cx1");
    expect(html).toMatch(/<option value="acct_cx3" disabled="">Old team · paused<\/option>/);
  });

  it("says nothing is chosen yet rather than showing the first account as chosen", () => {
    const html = render(null);
    expect(html).toMatch(/<option value="" disabled="" selected="">Not chosen yet<\/option>/);
    expect(render("acct_gone")).toContain("Not chosen yet");
  });
});
