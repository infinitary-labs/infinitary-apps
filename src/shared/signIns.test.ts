import { describe, expect, it } from "vitest";
import { inLanguage } from "./i18n/current";
import { englishOf, wordSaid } from "./i18n/said";
import { runsOnSaid } from "./repos";
import {
  type ComputerServedModel,
  computerSignInsSchema,
  devicePlace,
  SERVED_MODELS_MAX,
  servedForHome,
  signInPlace,
  wordedPlace,
} from "./signIns";

function openRouter(ids: readonly string[]): ComputerServedModel[] {
  return ids.map((id) => ({ provider: "openrouter", id }));
}

/** What a computer says of its sign-ins when it holds one OpenRouter account serving `models`. */
function said(models: ComputerServedModel[]) {
  return {
    providers: [],
    accounts: [],
    quota: null,
    served: [{ accountId: "acct_or", models }],
  };
}

describe("the models a computer lists for its home", () => {
  it("lists every model an account serves while they fit, as that computer read them", () => {
    // More than four hundred, as OpenRouter serves now.
    const models = openRouter(Array.from({ length: 450 }, (_, n) => `vendor-${n}/model-${n}`));
    expect(servedForHome("openrouter", models)).toEqual(models);
    expect(computerSignInsSchema.safeParse(said(models)).success).toBe(true);
  });

  it("keeps the Models board's rows when a provider outgrows the bound, so the home still reads the list", () => {
    const alias = "~anthropic/claude-sonnet-latest";
    const others = Array.from({ length: SERVED_MODELS_MAX }, (_, n) => `vendor-${n}/model-${n}`);
    const models = openRouter([...others, alias]);
    expect(computerSignInsSchema.safeParse(said(models)).success).toBe(false);

    const listed = servedForHome("openrouter", models);
    expect(listed).toHaveLength(SERVED_MODELS_MAX);
    expect(listed[0]).toEqual({ provider: "openrouter", id: alias });
    expect(computerSignInsSchema.safeParse(said(listed)).success).toBe(true);
  });
});

describe("where a sign-in or connection lives, in the reader's language", () => {
  const mini = signInPlace({ name: "Mac mini", onThisMac: false });
  const builder = signInPlace({ name: "Mac Studio", user: "builder", onThisMac: true });
  const gone = devicePlace([], "left-the-list");

  it("names another computer by its name and another user on this computer by theirs, in each language", () => {
    expect(
      inLanguage("de", () => [wordedPlace(mini), wordedPlace(builder), wordedPlace(gone)]),
    ).toEqual([
      { label: "Mac mini", where: "auf Mac mini", who: "Mac mini" },
      { label: "Läuft als Builder", where: "als Builder", who: "Builder" },
      {
        label: "Der andere Computer",
        where: "auf dem anderen Computer",
        who: "Der andere Computer",
      },
    ]);
    expect(inLanguage("ko", () => [wordedPlace(mini).where, wordedPlace(builder).label])).toEqual([
      "Mac mini에서",
      "Builder(으)로 실행",
    ]);
  });

  it("keeps the English words for served text, and the same words when worded in English", () => {
    for (const place of [mini, builder, gone]) {
      const { said: _, ...english } = place;
      expect(inLanguage("en", () => wordedPlace(place))).toEqual(english);
    }
    expect(builder).toMatchObject({
      label: "Running as Builder",
      where: "as Builder",
      who: "Builder",
    });
    expect(gone).toMatchObject({ where: "on the other computer", who: "The other computer" });
  });

  it("fills a saved line's blank with the place, so the line reads whole in each language", () => {
    const line = runsOnSaid("website", mini.said.where, false);
    expect(englishOf(line)).toBe(
      "website runs on Mac mini now. Its next task starts there; one already running finishes where it started.",
    );
    expect(inLanguage("de", () => wordSaid(line))).toBe(
      "website läuft jetzt auf Mac mini. Seine nächste Aufgabe startet dort; eine bereits laufende endet dort, wo sie begonnen hat.",
    );
    expect(inLanguage("ko", () => wordSaid(runsOnSaid("api", builder.said.where, false)))).toMatch(
      /^api은\(는\) 이제 Builder\(으\)로 실행돼요\./,
    );
  });
});
