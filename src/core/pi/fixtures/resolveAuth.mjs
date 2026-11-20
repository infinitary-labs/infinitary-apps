// Test-only two-process probe of Pi's actual resolver and auth-file locking.
const { AuthStorage } = await import(
  new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);

import { createModels } from "@earendil-works/pi-ai";

const [authPath, endpoint, providerId] = process.argv.slice(2);
if (process.env.INFINITARY_AUTH_PROOF !== "scratch-only") throw new Error("Scratch proof only");
const credentials = AuthStorage.create(authPath);
await credentials.read(providerId);
await fetch(`${endpoint}/ready`, { method: "POST" });
const models = createModels({ credentials });
models.setProvider({
  id: providerId,
  name: "Disposable OAuth",
  getModels: () => [],
  auth: {
    oauth: {
      name: "Disposable",
      login: async () => {
        throw new Error("No sign-in");
      },
      refresh: async (credential, signal) => {
        const response = await fetch(`${endpoint}/refresh`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh: credential.refresh }),
        });
        if (!response.ok) throw new Error("Single-use refresh already spent");
        return await response.json();
      },
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  },
});
const auth = await models.getAuth(providerId);
const later = await models.getAuth(providerId);
console.log(
  JSON.stringify({
    resolved: auth?.auth.apiKey === "disposable-new",
    later: later?.auth.apiKey === "disposable-new",
  }),
);
