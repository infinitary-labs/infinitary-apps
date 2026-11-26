import type { Provider } from "@earendil-works/pi-ai";

/**
 * A provider whose key comes only from the account's own store, never from
 * the process environment. Pi's standard key auth falls back to a variable
 * such as OPENCODE_API_KEY when nothing is stored, so with one set on the
 * computer a signed-out account would read signed in on that key, and every
 * other account's runtime would serve the provider's models on it
 * (INF-6873: accounts come only from the person's own sign-in). `check` goes
 * too, since Pi's availability pass would otherwise ask it the same way.
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
