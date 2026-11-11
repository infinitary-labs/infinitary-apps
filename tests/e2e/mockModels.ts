/**
 * The models.json files that point the app at the journey stand-in
 * (`tests/e2e/mockProvider.ts`): the one mock model under its own custom
 * provider, or a real catalog provider moved onto the stand-in's port.
 */

/** The provider the app's models.json defines the mock model under. */
export const MOCK_PROVIDER_ID = "fm-mock";

/** The id of the one mock model, as the app's models.json defines it. */
export const MOCK_MODEL_ID = "mock-1";

/** The catalog name of the one mock model - what a card's model chip calls it. */
export const MOCK_MODEL_LABEL = "Mock model";

/**
 * A models.json that defines NO custom provider and only points a real,
 * key-signed catalog provider at the mock server. The base runtime then
 * serves nothing (no key), so the first-launch gate is up; a key pasted
 * through the gate's own chip signs an OpenRouter account in, and that
 * account's runtime - reading the same app-scoped file - sends every turn
 * to the mock. The hermetic way to connect an account through the UI.
 * `provider` names another catalog provider a key signs in the same way,
 * such as Grok (`xai`), whose models routing may give a crewmate.
 */
export const MOCK_KEY_PROVIDER_ID = "openrouter";

export function mockProviderOverrideModelsJson(
  port: number,
  provider: string = MOCK_KEY_PROVIDER_ID,
): string {
  return `${JSON.stringify(
    {
      providers: {
        [provider]: { baseUrl: `http://127.0.0.1:${port}/v1` },
      },
    },
    null,
    2,
  )}\n`;
}

/** The app-scoped models.json contents pointing Pi at the mock server. */
export function mockModelsJson(port: number): string {
  return `${JSON.stringify(
    {
      providers: {
        [MOCK_PROVIDER_ID]: {
          name: "Mock provider",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "mock-key",
          models: [{ id: MOCK_MODEL_ID, name: MOCK_MODEL_LABEL, input: ["text", "image"] }],
        },
      },
    },
    null,
    2,
  )}\n`;
}
