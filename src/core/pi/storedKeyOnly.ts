import type { Provider } from "@earendil-works/pi-ai";

/**
 * A provider whose key comes only from the account's own store, never from
 * the process environment. Pi's standard key auth falls back to a variable
 * such as XAI_API_KEY, OPENROUTER_API_KEY, KIMI_API_KEY,
 * COPILOT_GITHUB_TOKEN or OPENCODE_API_KEY when nothing is stored, and a
 * Windows app, or one started from a terminal, keeps the computer's
 * variables. With one set, a signed-out account would read signed in on that
 * key, and every other account's runtime would serve the provider's models
 * on it: an account comes only from the person's own sign-in. A sign-in
 * Pi holds as OAuth resolves outside `apiKey`, so it stays as it is. `check`
 * goes too, since Pi's availability pass would otherwise ask it the same way.
 */
export function storedKeyOnly(stock: Provider): Provider {
  const apiKey = stock.auth.apiKey;
  if (!apiKey) return stock;
  const { check: _check, ...rest } = apiKey;
  void _check;
  return {
    ...stock,
    auth: {
      ...stock.auth,
      apiKey: {
        ...rest,
        resolve: (input) =>
          input.credential?.key ? apiKey.resolve(input) : Promise.resolve(undefined),
      },
    },
  };
}
