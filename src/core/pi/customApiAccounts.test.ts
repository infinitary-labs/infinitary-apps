import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { CustomApiInput } from "@shared/customApi";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { customPicture } from "../../../tests/helpers/customPictures";
import { AdaptedDecisionModel } from "../decisions/decisionModel";
import { ModelSlots } from "../routing/modelSlots";
import type { SessionEvent } from "../session/session";
import { boundTool } from "../session/tools";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { AccountVault } from "./accountVault";
import { fixture, input, vault, vaults } from "./customApiAccountsFixture";
import { CustomApiError } from "./customApiPolicy";
import { COMPACTED_PICTURES_NOTICE } from "./customPictureContext";
import { catalogRefreshesSettled } from "./modelRuntime";
import { usageFromMessage } from "./piEvents";
import { createPiSessionFactory } from "./session";

it("requires HTTP consent in every mode and permits keyless paused connections anywhere", async () => {
  const world = vault();
  for (const [mode, baseUrl] of [
    ["public", "http://8.8.8.8:4000/v1"],
    ["private", "http://10.20.30.40:4000/v1"],
    ["local", "http://127.0.0.1:4000/v1"],
  ] as const) {
    const candidate = { ...input(baseUrl), mode };
    expect(() =>
      world.vault.customPrepare({ ...candidate, unencryptedLocalApproved: false }),
    ).toThrow();
    const draft = world.vault.customPrepare(candidate);
    const saved = await world.vault.customSave(draft.draftId ?? "", true);
    expect(saved.enabled).toBe(false);
    expect(world.vault.customViews().find((view) => view.accountId === saved.id)).toMatchObject({
      baseUrl,
      mode,
      keyPresent: true,
    });
    // A server that needs no key gets none, on the public internet too.
    const keyless = world.vault.customPrepare({ ...candidate, noKey: true, key: "" });
    const savedKeyless = await world.vault.customSave(keyless.draftId ?? "", true);
    expect(
      world.vault.customViews().find((view) => view.accountId === savedKeyless.id),
    ).toMatchObject({
      noKey: true,
      keyPresent: false,
    });
  }
  const restored = AccountVault.create(world.paths);
  vaults.push(restored);
  expect(restored.customViews()).toHaveLength(6);
});

it("saves paused and restarts with zero requests, isolates duplicate addresses/IDs and keeps literal credentials private", async () => {
  const api = await fixture();
  const world = vault();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Credentials that look executable must stay opaque literal data.
  const key = "$(not-a-command) ${NOT_AN_ENV_REFERENCE}";
  const first = world.vault.customPrepare({
    ...input(api.baseUrl),
    key,
    models: [{ id: "../same-id", context: 0, output: 0 }],
  });
  expect(JSON.stringify(first)).not.toContain(key);
  const a = await world.vault.customSave(first.draftId ?? "", true);
  const bDraft = world.vault.customPrepare(input(api.baseUrl));
  const b = await world.vault.customSave(bDraft.draftId ?? "", true);
  expect(a.providerId).not.toBe(b.providerId);
  expect(world.vault.availableModels()).toEqual([]);
  expect(api.requests).toHaveLength(0);
  const restarted = AccountVault.create(world.paths);
  vaults.push(restarted);
  await restarted.warm();
  expect(restarted.customViews()).toHaveLength(2);
  expect(api.requests).toHaveLength(0);
  expect(() => restarted.setEnabled(a.id, true)).toThrow();
  const directory = join(world.paths.accountsDir, a.providerId, a.id);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, "custom-auth.json")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(await restarted.views())).not.toContain(key);
  expect(readFileSync(join(world.paths.accountsDir, "registry.json"), "utf8")).not.toContain(key);
  expect(readdirSync(directory)).toEqual(["custom-auth.json"]);
  await restarted.remove(a.id);
  expect(existsSync(join(world.paths.accountsDir, b.providerId, b.id))).toBe(true);
  // The duplicate live vault is just a restart stand-in; prevent double removal.
  vaults.splice(vaults.indexOf(world.vault), 1);
  console.info(
    "CUSTOM_API_PAUSED_STATE",
    JSON.stringify({
      requests: api.requests.length,
      distinctProviderIdentities: a.providerId !== b.providerId,
      keyNotInViewsOrRegistry: true,
      privateAuthMode: "0600",
      privateDirectoryMode: "0700",
    }),
  );
});

it("sends a connection's extra headers on every request, keeps secret values private and checks again after a change", async () => {
  const api = await fixture();
  const world = vault();
  const secret = "synthetic-gateway-secret";
  const draft = world.vault.customPrepare({
    ...input(api.baseUrl),
    headers: [
      { name: "X-Org-Id", value: "eng", secret: false },
      { name: "X-Gateway-Token", value: secret, secret: true },
    ],
  });
  expect(draft.headers).toEqual([
    { name: "X-Org-Id", secret: false, value: "eng" },
    { name: "X-Gateway-Token", secret: true },
  ]);
  expect(JSON.stringify(draft)).not.toContain(secret);
  expect(api.requests).toHaveLength(0);
  await world.vault.customDiscover(draft.draftId ?? "");
  await world.vault.customCheck(draft.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const runtime = await world.vault.runtimeFor(account.id);
  const model = runtime.getModel(account.providerId, "operator-model");
  if (!model) throw new Error("Checked model is missing");
  const reply = await runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Synthetic request", timestamp: Date.now() }],
  });
  expect(reply.stopReason).toBe("stop");
  // The model list, three check requests and the turn.
  expect(api.requests).toHaveLength(5);
  for (const request of api.requests) {
    expect(request.extra).toEqual({ org: "eng", token: secret });
    expect(request.authorization).toBe("Bearer opaque-synthetic-secret");
  }
  const target = join(world.paths.accountsDir, account.providerId, account.id, "custom-auth.json");
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(readFileSync(target, "utf8")).toContain(secret);
  expect(JSON.stringify(await world.vault.views())).not.toContain(secret);
  expect(JSON.stringify(world.vault.customViews())).not.toContain(secret);
  expect(readFileSync(join(world.paths.accountsDir, "registry.json"), "utf8")).not.toContain(
    secret,
  );

  // An edit at the same address that leaves the secret empty keeps its saved value,
  // and the changed headers need a fresh check before use.
  const edit = world.vault.customPrepare({
    ...input(api.baseUrl),
    key: "",
    replaceAccountId: account.id,
    headers: [
      { name: "X-Org-Id", value: "research", secret: false },
      { name: "x-gateway-token", value: "", secret: true },
    ],
  });
  expect(edit.models[0]?.checked).toBe(false);
  await world.vault.customCheck(edit.draftId ?? "", "operator-model");
  expect(api.requests.at(-1)?.extra).toEqual({ org: "research", token: secret });
  world.vault.customCancel(edit.draftId ?? "");
  // A changed address never inherits a saved secret value.
  expect(() =>
    world.vault.customPrepare({
      ...input(`${api.baseUrl}/new`),
      replaceAccountId: account.id,
      headers: [{ name: "X-Gateway-Token", value: "", secret: true }],
    }),
  ).toThrow("Enter each extra header once");

  world.vault.customClose(account.id);
  vaults.splice(vaults.indexOf(world.vault), 1);
  const restarted = AccountVault.create(world.paths);
  vaults.push(restarted);
  await restarted.warm();
  expect(restarted.customViews()[0]).toMatchObject({
    headers: [
      { name: "X-Org-Id", secret: false, value: "eng" },
      { name: "X-Gateway-Token", secret: true },
    ],
    models: [{ checked: true }],
  });
});

it("reads the server's models and stated limits before any is entered, and saves only with one", async () => {
  const api = await fixture();
  const world = vault();
  const empty = world.vault.customPrepare({ ...input(api.baseUrl), models: [] });
  expect(empty.models).toEqual([]);
  expect(api.requests).toHaveLength(0);
  const listed = await world.vault.customDiscover(empty.draftId ?? "");
  expect(listed).toEqual([
    { id: "listed-model", context: 131072, output: 8192 },
    { id: "unlisted-limits" },
  ]);
  expect(api.requests.map(({ path, authorization }) => ({ path, authorization }))).toEqual([
    { path: "/v1/models", authorization: "Bearer opaque-synthetic-secret" },
  ]);
  await expect(world.vault.customSave(empty.draftId ?? "", true)).rejects.toThrow(
    "Add at least one model before saving.",
  );
  // The form re-prepares the same approved setup with the chosen listed model;
  // the owner keeps the key it already holds for this address.
  const chosen = world.vault.customPrepare({
    ...input(api.baseUrl),
    key: "",
    sourceDraftId: empty.draftId,
    models: [{ id: "listed-model", context: 131072, output: 8192 }],
  });
  const checked = await world.vault.customCheck(chosen.draftId ?? "", "listed-model");
  expect(checked.models).toMatchObject([
    { id: "listed-model", context: 131072, output: 8192, checked: true },
  ]);
  const account = await world.vault.customSave(chosen.draftId ?? "", false);
  const runtime = await world.vault.runtimeFor(account.id);
  expect(runtime.getModel(account.providerId, "listed-model")).toMatchObject({
    contextWindow: 131072,
    maxTokens: 8192,
  });
});

it("connects by reading the address's network, fills the limits nobody typed and keeps the draft through a failed list", async () => {
  const api = await fixture();
  const world = vault();
  const { mode: _, ...form } = input(api.baseUrl);
  // A loopback address is this Mac's; no network choice is asked.
  const connected = await world.vault.customConnect({
    ...form,
    models: [
      { id: "listed-model", context: 0, output: 0 },
      { id: "typed-model", context: 65536, output: 1024 },
    ],
  });
  expect(connected.failure).toBeUndefined();
  expect(connected.view).toMatchObject({
    mode: "local",
    baseUrl: api.baseUrl,
    models: [
      { id: "listed-model", context: 131072, output: 8192, checked: false },
      { id: "typed-model", context: 65536, output: 1024, checked: false },
    ],
  });
  expect(connected.listed?.map((model) => model.id)).toEqual(["listed-model", "unlisted-limits"]);
  const checked = await world.vault.customCheck(connected.view?.draftId ?? "", "listed-model");
  expect(checked.models[0]).toMatchObject({ checked: true });

  // The key refused: a category, never thrown text, and the draft stays for a paused save.
  api.refuse(401);
  const refused = await world.vault.customConnect({
    ...form,
    models: [{ id: "listed-model", context: 0, output: 0 }],
  });
  expect(refused.failure).toEqual({ category: "key-rejected", stage: "list" });
  const kept = await world.vault.customSave(refused.view?.draftId ?? "", true);
  expect(world.vault.customViews().find((view) => view.accountId === kept.id)).toMatchObject({
    mode: "local",
    enabled: false,
  });
  api.refuse(200);

  // A failed check says why as a category the form places on the row.
  const unsized = await world.vault.customConnect({
    ...form,
    models: [{ id: "unlisted-limits", context: 0, output: 0 }],
  });
  const failed = await world.vault.customCheck(unsized.view?.draftId ?? "", "unlisted-limits");
  expect(failed.models[0]).toMatchObject({ checked: false, category: "limits" });
});

it("refuses an address before anything is sent, with the category and any base address to use", async () => {
  const api = await fixture();
  const world = vault();
  const { mode: _, ...form } = input(api.baseUrl);
  const at = (baseUrl: string) =>
    world.vault.customConnect({ ...form, baseUrl, approvedDestination: baseUrl });
  expect(await at(`${api.baseUrl}/chat/completions`)).toEqual({
    failure: { category: "address", stage: "address", suggestion: api.baseUrl },
  });
  expect(await at("http://169.254.169.254/v1")).toEqual({
    failure: { category: "destination", stage: "address" },
  });
  // The approval binds the address Save showed.
  expect(
    await world.vault.customConnect({ ...form, approvedDestination: `${api.baseUrl}/other` }),
  ).toEqual({ failure: { category: "destination", stage: "address" } });
  expect(api.requests).toHaveLength(0);
  expect(await world.vault.customAddress(`${api.baseUrl}/`)).toEqual({
    destination: api.baseUrl,
    network: "local",
  });
  expect(await world.vault.customAddress(`${api.baseUrl}/models`)).toEqual({
    suggestion: api.baseUrl,
    failure: "address",
  });
});

it("keeps a saved connection's network on a same-address edit, and reads a changed address afresh", async () => {
  const api = await fixture();
  const world = vault();
  const port = new URL(api.baseUrl).port;
  const named = `http://localhost:${port}/v1`;
  // Saved with an explicit class before it was read from the address: public.
  const saved = world.vault.customPrepare({ ...input(named), mode: "public" });
  const account = await world.vault.customSave(saved.draftId ?? "", true);
  const { mode: _, ...form } = input(named);
  // The edit keeps that class rather than reading this Mac's from DNS, and every
  // request is still held to it: the name's loopback answer is refused.
  const edit = await world.vault.customConnect({ ...form, replaceAccountId: account.id });
  expect(edit.view).toMatchObject({ mode: "public", baseUrl: named });
  expect(edit.failure).toEqual({ category: "destination", stage: "list" });
  expect(world.vault.customReplacement(edit.view?.draftId ?? "")).toBe(account.id);
  expect(api.requests).toHaveLength(0);
  // A different address is a separate connection, with the network it points to.
  const moved = await world.vault.customConnect({
    ...input(api.baseUrl),
    replaceAccountId: account.id,
  });
  expect(moved.view).toMatchObject({ mode: "local" });
  expect(world.vault.customReplacement(moved.view?.draftId ?? "")).toBeUndefined();
});

it.each(["openai-completions", "openai-responses"] as const)(
  "uses checked %s models through real Pi without fallback or optional cache fields",
  async (protocol) => {
    const api = await fixture();
    const world = vault();
    const draft = world.vault.customPrepare(input(api.baseUrl, protocol));
    const checked = await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    expect(checked.models[0]?.checked).toBe(true);
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    expect(world.vault.availableModels()).toEqual([
      {
        provider: account.providerId,
        id: "operator-model",
        name: "operator-model",
        reasoningCapabilities: { levels: [], fixed: "off" },
      },
    ]);
    const runtime = await world.vault.runtimeFor(account.id);
    const model = runtime.getModel(account.providerId, "operator-model");
    if (!model) throw new Error("Checked model is missing");
    const reply = await runtime.completeSimple(
      model,
      {
        systemPrompt: "Synthetic session instruction",
        messages: [{ role: "user", content: "Synthetic request", timestamp: Date.now() }],
      },
      {
        reasoning: "high",
        temperature: 0.7,
        sessionId: "internal-affinity-must-not-leave",
        cacheRetention: "long",
        headers: { "X-Test": "must-not-leave" },
      },
    );
    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toEqual([
      {
        type: "text",
        text: "Synthetic work answer.",
        ...(protocol === "openai-responses"
          ? { textSignature: JSON.stringify({ v: 1, id: "msg_1" }) }
          : {}),
      },
    ]);
    expect(reply.usage.input).toBe(0);
    expect(reply.usage.cost.total).toBeNaN();
    const wire = api.requests.at(-1);
    expect(wire?.authorization).toBe("Bearer opaque-synthetic-secret");
    expect(wire?.body).not.toHaveProperty("prompt_cache_key");
    expect(wire?.body).not.toHaveProperty("cacheRetention");
    expect(wire?.body).not.toHaveProperty("sessionId");
    expect(wire?.body).not.toHaveProperty("reasoning");
    if (protocol === "openai-responses") expect(wire?.body.store).toBe(false);
    world.vault.setEnabled(account.id, false);
    const count = api.requests.length;
    const paused = runtime.completeSimple(model, {
      messages: [{ role: "user", content: "After pause", timestamp: Date.now() }],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(api.requests).toHaveLength(count);
    world.vault.setEnabled(account.id, true);
    expect((await paused).stopReason).toBe("stop");
    await world.vault.remove(account.id);
    expect(
      (
        await runtime.completeSimple(model, {
          messages: [{ role: "user", content: "After disconnect", timestamp: Date.now() }],
        })
      ).stopReason,
    ).toBe("error");
    expect(existsSync(join(world.paths.accountsDir, account.providerId))).toBe(false);
    console.info(
      "CUSTOM_API_RUNTIME_WIRE",
      JSON.stringify({
        protocol,
        request: wire?.body,
        credentialMatches: wire?.authorization === "Bearer opaque-synthetic-secret",
        pauseBlockedThenResumed: true,
        disconnectTerminal: true,
        unknownUsageAndPrice: true,
      }),
    );
  },
);

it.each(["openai-completions", "openai-responses"] as const)(
  "a %s turn takes a long reply that its connection check could not",
  async (protocol) => {
    const api = await fixture();
    const world = vault();
    const draft = world.vault.customPrepare({
      ...input(api.baseUrl, protocol),
      models: [{ id: "operator-model", context: 131072, output: 32768 }],
    });
    const checked = await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    expect(checked.models[0]?.checked).toBe(true);
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const model = runtime.getModel(account.providerId, "operator-model");
    if (!model) throw new Error("Checked model is missing");
    // 20,000 tokens, one frame each: more frames and bytes than a check may take.
    const pieces = Array.from({ length: 20_000 }, (_, index) => `word${index % 10} `);
    api.answer(pieces);
    const reply = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "Synthetic long request", timestamp: Date.now() }],
    });
    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toEqual([
      {
        type: "text",
        text: pieces.join(""),
        ...(protocol === "openai-responses"
          ? { textSignature: JSON.stringify({ v: 1, id: "msg_1" }) }
          : {}),
      },
    ]);
  },
);

it.each(["openai-completions", "openai-responses"] as const)(
  "a %s turn on a large-context model sends a session past 1 MiB, up to its documented context",
  async (protocol) => {
    const api = await fixture();
    const world = vault();
    const draft = world.vault.customPrepare({
      ...input(api.baseUrl, protocol),
      models: [{ id: "operator-model", context: 1_048_576, output: 32_768 }],
    });
    const checked = await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    expect(checked.models[0]?.checked).toBe(true);
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const model = runtime.getModel(account.providerId, "operator-model");
    if (!model) throw new Error("Checked model is missing");
    // A crewmate session that has read files back as tool results.
    const file = "export const line = 'a line of synthetic source code';\n".repeat(1000);
    const session = (files: number): Message[] => [
      { role: "user", content: "Read the project's files.", timestamp: Date.now() },
      ...Array.from({ length: files }, (_, index): Message[] => [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: `read_${index}`, name: "read", arguments: {} }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: `read_${index}`,
          toolName: "read",
          content: [{ type: "text", text: file }],
          isError: false,
          timestamp: Date.now(),
        },
      ]).flat(),
    ];
    // About 2.8 MB. The connection's wire cap allows it; Pi decides the window.
    const reply = await runtime.completeSimple(model, { messages: session(50) });
    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toEqual([
      {
        type: "text",
        text: "Synthetic work answer.",
        ...(protocol === "openai-responses"
          ? { textSignature: JSON.stringify({ v: 1, id: "msg_1" }) }
          : {}),
      },
    ]);
    const sent = JSON.stringify(api.requests.at(-1)?.body);
    expect(sent.split("a line of synthetic source code").length - 1).toBe(50 * 1000);
    expect(Buffer.byteLength(sent)).toBeGreaterThan(2 * 1024 * 1024);
    // INF-202: a session the old check refused, about 3.3 MB, is sent.
    const count = api.requests.length;
    const over = await runtime.completeSimple(model, { messages: session(60) });
    expect(over.stopReason).toBe("stop");
    expect(api.requests.length).toBeGreaterThan(count);
  },
);

it.each(["openai-completions", "openai-responses"] as const)(
  "a %s turn sends a tool result's picture as a short text note, not a refusal",
  async (protocol) => {
    const api = await fixture();
    const world = vault();
    const draft = world.vault.customPrepare(input(api.baseUrl, protocol));
    await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const model = runtime.getModel(account.providerId, "operator-model");
    if (!model) throw new Error("Checked model is missing");
    const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const messages: Message[] = [
      { role: "user", content: "Capture the panel.", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "capture_1", name: "capture_panel", arguments: {} }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "capture_1",
        toolName: "capture_panel",
        content: [{ type: "text", text: "Captured two screenshots." }, png, png],
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const before = api.requests.length;
    const reply = await runtime.completeSimple(model, { messages });
    expect(reply.stopReason).toBe("stop");
    expect(api.requests).toHaveLength(before + 1);
    const sent = JSON.stringify(api.requests.at(-1)?.body);
    expect(sent).toContain("Captured two screenshots.");
    expect(sent.split("(tool image omitted: model does not support images)").length - 1).toBe(1);
    expect(sent).not.toContain("iVBORw0KGgo=");
  },
);

it("failed or cancelled key replacement preserves the working revision and changed addresses cannot replace it", async () => {
  const api = await fixture();
  const world = vault();
  const draft = world.vault.customPrepare(input(api.baseUrl));
  await world.vault.customCheck(draft.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const target = join(world.paths.accountsDir, account.providerId, account.id, "custom-auth.json");
  const before = readFileSync(target, "utf8");
  api.refuse(401);
  const replacement = world.vault.customPrepare({
    ...input(api.baseUrl),
    replaceAccountId: account.id,
    key: "candidate-key",
  });
  const failure = await world.vault.customCheck(replacement.draftId ?? "", "operator-model");
  expect(failure.models[0]).toMatchObject({ checked: false, state: "key-rejected" });
  await expect(world.vault.customSave(replacement.draftId ?? "", false)).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe(before);
  world.vault.customCancel(replacement.draftId ?? "");
  expect(readFileSync(target, "utf8")).toBe(before);
  const changed = world.vault.customPrepare({
    ...input(`${api.baseUrl}/new`),
    replaceAccountId: account.id,
    key: "fresh-key",
  });
  expect(world.vault.customReplacement(changed.draftId ?? "")).toBeUndefined();
  const separate = await world.vault.customSave(changed.draftId ?? "", true);
  expect(separate.id).not.toBe(account.id);
  expect(readFileSync(target, "utf8")).toBe(before);
});

it.each(["openai-completions", "openai-responses"] as const)(
  "guards real %s tool replay, compaction and the background decision consumer",
  async (protocol) => {
    const api = await fixture();
    const world = vault();
    api.pictures();
    const draft = world.vault.customPrepare(input(api.baseUrl, protocol));
    await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const model = { provider: account.providerId, id: "operator-model" };
    const factory = createPiSessionFactory({ agentDir: join(world.paths.userData, "agent") });
    const echoed: string[] = [];
    const events: SessionEvent[] = [];
    const session = await factory.open({
      machine: "local",
      owner: "synthetic-session",
      cwd: world.paths.userData,
      binding: { backend: "pi", accountId: account.id, runtime },
      model,
      thinking: { level: "high" },
      instructions: { base: "Synthetic session instruction" },
      builtins: "none",
      tools: [
        boundTool({
          name: "session_echo",
          label: "Synthetic echo",
          description: "Echo a synthetic value in memory",
          parameters: Type.Object({ text: Type.String() }),
          run: ({ text }) => {
            echoed.push(text);
            return { text };
          },
        }),
      ],
      shape: { turns: "rolling", record: { dir: join(world.paths.userData, "sessions") } },
    });
    session.subscribe((event) => events.push(event));
    const db = openInMemoryDatabase();
    try {
      // INF-1996: a real compaction drops this early picture, not silent per-request trimming.
      await session.prompt("Inspect the earlier crop.", [
        { data: customPicture(32, 24), mimeType: "image/png" },
      ]);
      api.tools();
      await session.prompt("Synthetic tool work");
      expect(echoed).toEqual(["session-value"]);
      api.highUsage();
      await session.prompt(`Synthetic long context ${"synthetic words ".repeat(6500)}`);
      await session.prompt("Synthetic continuation after compaction");
      const compaction = events.filter(
        (event) => event.type === "tool_end" && event.callId === "synthetic-session:compaction",
      );
      expect(compaction).toContainEqual(expect.objectContaining({ isError: false }));
      const activeWire = JSON.stringify(api.requests.at(-1)?.body);
      expect(activeWire).toContain(COMPACTED_PICTURES_NOTICE);
      expect(activeWire).not.toContain("data:image/png;base64,");
      const pictureRecord = session.recordPath();
      if (!pictureRecord) throw new Error("Picture session record is missing");
      const savedRecord = readFileSync(pictureRecord, "utf8");
      expect(savedRecord).toContain('"type":"image"');
      const slots = new ModelSlots({
        settings: new SettingsStore(db),
        accounts: () => [
          {
            accountId: account.id,
            accountLabel: "Synthetic",
            providerId: account.providerId,
            models: world.vault.availableModels(),
          },
        ],
        quotaModels: () => undefined,
      });
      const decisions = new AdaptedDecisionModel({
        homeDir: world.paths.userData,
        availableModels: () => slots.routable(world.vault.availableModels()).models,
        quotaModels: () => undefined,
        selectAccount: () => account.id,
        flagshipAccountId: () => null,
        runtimeFor: (id) => world.vault.runtimeFor(id),
        sessions: { pi: factory },
      });
      const caller = { purpose: "synthetic-background", taskId: "synthetic-task" };
      const state = { facts: { text: "Synthetic background question" } };
      const questions = {
        allowed: {
          type: "choice" as const,
          version: "synthetic1",
          instructions: "Answer yes or no",
          criteria: { yes: "yes", no: "no" },
          abstain: "no",
        },
      };
      const before = api.requests.length;
      expect(
        (await decisions.decide(caller, state, questions, new AbortController().signal)).answers
          .allowed?.reason,
      ).toBe("no-model");
      expect(api.requests).toHaveLength(before);
      slots.setSlotMembership(`${model.provider}/${model.id}`, "low", true);
      api.answer("yes");
      expect(
        (await decisions.decide(caller, state, questions, new AbortController().signal)).answers
          .allowed,
      ).toMatchObject({ value: "yes", outcome: "answered" });
      expect(
        api.requests.at(-1)?.body[
          protocol === "openai-responses" ? "max_output_tokens" : "max_tokens"
        ],
      ).toBe(64);
      world.vault.setEnabled(account.id, false);
      const pausedCount = api.requests.length;
      expect(
        (await decisions.decide(caller, state, questions, new AbortController().signal)).answers
          .allowed?.reason,
      ).toBe("no-model");
      expect(api.requests).toHaveLength(pausedCount);
      world.vault.setEnabled(account.id, true);
      api.refuse(403);
      const requestsBeforeRefusal = api.requests.length;
      await session.prompt("Synthetic refused work");
      expect(api.requests).toHaveLength(requestsBeforeRefusal + 1);
      expect(events).toContainEqual(expect.objectContaining({ type: "turn_failed" }));
      api.refuse(200);
      api.answer("opaque-synthetic-secret");
      await session.prompt("Synthetic unsafe response");
      expect(JSON.stringify(events)).not.toContain("opaque-synthetic-secret");
      for (const event of events)
        if (event.type === "turn_end") expect(event.usage?.cost).toBeUndefined();
      const record = session.recordPath();
      expect(record).toBeTruthy();
      expect(readFileSync(record ?? "", "utf8")).not.toContain("opaque-synthetic-secret");
      expect(JSON.stringify(await world.vault.views())).not.toContain("opaque-synthetic-secret");
      for (const request of api.requests) {
        expect(request.authorization).toBe("Bearer opaque-synthetic-secret");
        expect(request.body).not.toHaveProperty("prompt_cache_key");
        expect(request.body).not.toHaveProperty("reasoning");
        expect(request.body).not.toHaveProperty("previous_response_id");
        expect(request.body).not.toHaveProperty("session_id");
        if (protocol === "openai-responses") expect(request.body.store).toBe(false);
      }
      const resume = session.resume();
      session.dispose();
      await session.closed();
      api.answer("Continue the comparison.");
      const resumed = await factory.open({
        machine: "local",
        owner: "picture-resume",
        cwd: world.paths.userData,
        binding: { backend: "pi", accountId: account.id, runtime },
        model,
        thinking: { level: "high" },
        instructions: { base: "Synthetic session instruction" },
        builtins: "none",
        tools: [],
        shape: {
          turns: "rolling",
          record: { dir: join(world.paths.userData, "sessions"), resume },
        },
      });
      try {
        await resumed.prompt("Continue after reopening.");
        expect(JSON.stringify(api.requests.at(-1)?.body)).toContain(COMPACTED_PICTURES_NOTICE);
      } finally {
        resumed.dispose();
      }
      console.info(
        "CUSTOM_PICTURE_FACTORY_COMPACTION",
        JSON.stringify({
          protocol,
          activePictures: 0,
          notice: COMPACTED_PICTURES_NOTICE,
          savedPicture: true,
          resumedNotice: true,
        }),
      );
      const evidence = {
        protocol,
        echoed,
        compactionSucceeded: true,
        unplacedAndPausedBackgroundRequests: 0,
        selectedDecisionAnswered: true,
        hostileErrorAbsentFromSessionAndViews: true,
        wire: api.requests.map(({ path, body, authorization }) => ({
          path,
          body,
          literalCredentialMatches: authorization === "Bearer opaque-synthetic-secret",
        })),
      };
      mkdirSync("test-results/custom-api", { recursive: true });
      writeFileSync(
        `test-results/custom-api/${protocol}-consumers.json`,
        JSON.stringify(evidence, null, 2),
      );
      console.info(
        "CUSTOM_API_CONSUMERS",
        JSON.stringify({
          protocol,
          requests: api.requests.length,
          compaction: compaction.length,
          decisionAnswered: true,
        }),
      );
    } finally {
      session.dispose();
      await session.closed();
      db.close();
    }
  },
);

/**
 * A rolling session on a checked 128k-token model. Its one tool reads back a file's text.
 */
async function longSession(protocol: CustomApiInput["protocol"]) {
  const api = await fixture();
  const world = vault();
  const draft = world.vault.customPrepare({
    ...input(api.baseUrl, protocol),
    models: [{ id: "operator-model", context: 131072, output: 8192 }],
  });
  await world.vault.customCheck(draft.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const runtime = await world.vault.runtimeFor(account.id);
  const factory = createPiSessionFactory({ agentDir: join(world.paths.userData, "agent") });
  const file = "export const line = 'a line of synthetic source code';\n".repeat(700);
  const session = await factory.open({
    machine: "local",
    owner: "synthetic-session",
    cwd: world.paths.userData,
    binding: { backend: "pi", accountId: account.id, runtime },
    model: { provider: account.providerId, id: "operator-model" },
    thinking: { level: "off" },
    instructions: { base: "Synthetic session instruction" },
    builtins: "none",
    tools: [
      boundTool({
        name: "read_file",
        label: "Read a file",
        description: "Read a synthetic file in memory",
        parameters: Type.Object({ path: Type.String() }),
        run: () => ({ text: file }),
      }),
    ],
    shape: { turns: "rolling", record: { dir: join(world.paths.userData, "sessions") } },
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { api, session, events, file };
}

it.each(["openai-completions", "openai-responses"] as const)(
  "a long %s session compacts from the server's count instead of failing a turn",
  async (protocol) => {
    const { api, session, events, file } = await longSession(protocol);
    api.count();
    const turns = 14;
    try {
      // Each prompt carries a file's text, as a person pasting code does.
      for (let turn = 1; turn <= turns; turn++) {
        await session.prompt(`Turn ${turn}:\n${file}`);
      }
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_end",
          callId: "synthetic-session:compaction",
          isError: false,
        }),
      );
      for (let turn = 1; turn <= turns; turn++) {
        expect(
          api.requests.some((request) => JSON.stringify(request.body).includes(`Turn ${turn}:`)),
        ).toBe(true);
      }
      expect(events.filter((event) => event.type === "turn_closed")).toEqual(
        Array.from({ length: turns }, () => ({
          type: "turn_closed",
          text: "Synthetic work answer.",
        })),
      );

      // INF-202: a prompt the old check refused is sent, and the model answers it.
      const failures = events.length;
      const before = api.requests.length;
      await session.prompt(`Oversized:\n${file.repeat(11)}`);
      expect(events.slice(failures).filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(
        api.requests
          .slice(before)
          .some((request) => JSON.stringify(request.body).includes("Oversized:")),
      ).toBe(true);
      expect(events.filter((event) => event.type === "turn_closed").at(-1)).toEqual({
        type: "turn_closed",
        text: "Synthetic work answer.",
      });
    } finally {
      session.dispose();
      await session.closed();
    }
  },
);

it.each(["openai-completions", "openai-responses"] as const)(
  "a %s turn that reads many files compacts between its requests instead of failing",
  async (protocol) => {
    const { api, session, events } = await longSession(protocol);
    try {
      api.reads(20);
      await session.prompt("Read the project's twenty files, then say what you found.");
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(
        events.filter((event) => event.type === "tool_end" && event.toolName === "read_file"),
      ).toHaveLength(20);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_end",
          callId: "synthetic-session:compaction",
          isError: false,
        }),
      );
      expect(events.filter((event) => event.type === "turn_closed").at(-1)).toEqual({
        type: "turn_closed",
        text: "Synthetic work answer.",
      });
    } finally {
      session.dispose();
      await session.closed();
    }
  },
);

it("keeps in-flight/pending work isolated across Pause, checked replacement, cancellation and Disconnect", async () => {
  const api = await fixture();
  const world = vault();
  const initial = world.vault.customPrepare(input(api.baseUrl));
  await world.vault.customCheck(initial.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(initial.draftId ?? "", false);
  const runtime = await world.vault.runtimeFor(account.id);
  const model = runtime.getModel(account.providerId, "operator-model");
  if (!model) throw new Error("Missing model");
  const authPath = join(
    world.paths.accountsDir,
    account.providerId,
    account.id,
    "custom-auth.json",
  );
  const working = readFileSync(authPath, "utf8");
  const arrived = api.hold("work");
  const active = runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Synthetic admitted work", timestamp: Date.now() }],
  });
  await arrived;
  world.vault.setEnabled(account.id, false);
  const replacement = world.vault.customPrepare({
    ...input(api.baseUrl),
    replaceAccountId: account.id,
    key: "candidate-synthetic-key",
  });
  await world.vault.customCheck(replacement.draftId ?? "", "operator-model");
  await expect(world.vault.customSave(replacement.draftId ?? "", false)).rejects.toThrow("finish");
  expect(readFileSync(authPath, "utf8")).toBe(working);
  api.release();
  expect((await active).stopReason).toBe("stop");
  await world.vault.customSave(replacement.draftId ?? "", false);
  expect(world.vault.customViews().find((entry) => entry.accountId === account.id)?.enabled).toBe(
    false,
  );
  world.vault.setEnabled(account.id, true);
  expect(
    (
      await runtime.completeSimple(model, {
        messages: [{ role: "user", content: "Synthetic replacement work", timestamp: Date.now() }],
      })
    ).stopReason,
  ).toBe("stop");
  expect(api.requests.at(-1)?.authorization).toBe("Bearer candidate-synthetic-key");
  const afterReplacement = readFileSync(authPath, "utf8");
  const candidate = world.vault.customPrepare({
    ...input(api.baseUrl),
    replaceAccountId: account.id,
    key: "cancelled-synthetic-key",
  });
  const checkArrived = api.hold("check");
  const checking = world.vault.customCheck(candidate.draftId ?? "", "operator-model");
  await checkArrived;
  world.vault.customCancel(candidate.draftId ?? "");
  api.release();
  await expect(checking).rejects.toThrow();
  expect(readFileSync(authPath, "utf8")).toBe(afterReplacement);
  await expect(world.vault.customSave(candidate.draftId ?? "", false)).rejects.toThrow();
  const siblingDraft = world.vault.customPrepare(input(api.baseUrl));
  const sibling = await world.vault.customSave(siblingDraft.draftId ?? "", true);
  const disconnectArrived = api.hold("work");
  const interrupted = runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Synthetic interrupted work", timestamp: Date.now() }],
  });
  await disconnectArrived;
  world.vault.setEnabled(account.id, false);
  const pending = runtime.completeSimple(model, {
    messages: [{ role: "user", content: "Synthetic paused work", timestamp: Date.now() }],
  });
  await world.vault.remove(account.id);
  api.release();
  expect((await interrupted).stopReason).toBe("error");
  expect((await pending).stopReason).toBe("error");
  await catalogRefreshesSettled();
  expect(existsSync(join(world.paths.accountsDir, account.providerId))).toBe(false);
  expect(existsSync(join(world.paths.accountsDir, sibling.providerId, sibling.id))).toBe(true);
  console.info(
    "CUSTOM_API_LIFECYCLE",
    JSON.stringify({
      pauseAllowedAdmittedRequest: true,
      checkedReplacementWaitedForIdle: true,
      preservedPause: true,
      cancelledCheckPreservedWorkingFile: true,
      disconnectStoppedActiveAndPending: true,
      siblingPreserved: true,
      lateFiles: false,
    }),
  );
});

it("checks exact Responses storage consent, persists it on restart, invalidates changes and never transfers approval", async () => {
  const api = await fixture();
  const world = vault();
  expect(() =>
    world.vault.customPrepare({
      ...input(api.baseUrl, "openai-responses"),
      allowStorageDefault: true,
    }),
  ).toThrow();
  expect(api.requests).toHaveLength(0);
  const initial = world.vault.customPrepare(input(api.baseUrl, "openai-responses"));
  await world.vault.customCheck(initial.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(initial.draftId ?? "", false);
  api.refuse(400);
  const count = api.requests.length;
  const rt = await world.vault.runtimeFor(account.id);
  const model = rt.getModel(account.providerId, "operator-model");
  if (!model) throw new Error("Missing model");
  expect(
    (
      await rt.completeSimple(model, {
        messages: [{ role: "user", content: "Synthetic default policy", timestamp: Date.now() }],
      })
    ).stopReason,
  ).toBe("error");
  expect(api.requests).toHaveLength(count + 1);
  expect(api.requests.at(-1)?.body.store).toBe(false);
  api.refuse(200);
  const consent = world.vault.customPrepare({
    ...input(api.baseUrl, "openai-responses"),
    replaceAccountId: account.id,
    allowStorageDefault: true,
    storageApproved: true,
  });
  expect(consent.models[0]?.checked).toBe(false);
  await world.vault.customCheck(consent.draftId ?? "", "operator-model");
  for (const request of api.requests.slice(-2)) expect(request.body).not.toHaveProperty("store");
  await world.vault.customSave(consent.draftId ?? "", false);
  world.vault.customClose(account.id);
  vaults.splice(vaults.indexOf(world.vault), 1);
  const restarted = AccountVault.create(world.paths);
  vaults.push(restarted);
  const beforeWarm = api.requests.length;
  await restarted.warm();
  expect(api.requests).toHaveLength(beforeWarm);
  expect(restarted.customViews()[0]).toMatchObject({
    allowStorageDefault: true,
    models: [{ checked: true }],
  });
  const resumed = await restarted.runtimeFor(account.id);
  const resumedModel = resumed.getModel(account.providerId, "operator-model");
  if (!resumedModel) throw new Error("Missing restart model");
  expect(
    (
      await resumed.completeSimple(resumedModel, {
        messages: [{ role: "user", content: "Synthetic consented policy", timestamp: Date.now() }],
      })
    ).stopReason,
  ).toBe("stop");
  expect(api.requests.at(-1)?.body).not.toHaveProperty("store");
  const changed = restarted.customPrepare({
    ...input(`${api.baseUrl}/new`, "openai-responses"),
    replaceAccountId: account.id,
    key: "fresh-synthetic-key",
  });
  expect(changed.allowStorageDefault).toBe(false);
  const separate = await restarted.customSave(changed.draftId ?? "", true);
  expect(separate.id).not.toBe(account.id);
  const revoke = restarted.customPrepare({
    ...input(api.baseUrl, "openai-responses"),
    replaceAccountId: account.id,
  });
  expect(revoke.models[0]?.checked).toBe(false);
  await restarted.customCheck(revoke.draftId ?? "", "operator-model");
  for (const request of api.requests.slice(-2)) expect(request.body.store).toBe(false);
  await restarted.customSave(revoke.draftId ?? "", false);
  expect(
    (
      await resumed.completeSimple(resumedModel, {
        messages: [{ role: "user", content: "Synthetic revoked policy", timestamp: Date.now() }],
      })
    ).stopReason,
  ).toBe("stop");
  expect(api.requests.at(-1)?.body.store).toBe(false);
  for (const request of api.requests) {
    expect(request.body.store).not.toBe(true);
    expect(request.body).not.toHaveProperty("previous_response_id");
    expect(request.body).not.toHaveProperty("conversation");
  }
  mkdirSync("test-results/custom-api", { recursive: true });
  writeFileSync(
    "test-results/custom-api/storage-lifecycle.json",
    JSON.stringify(
      {
        noOmissionWithoutConsent: true,
        rejectionNoRetry: true,
        proofInvalidation: true,
        approvalPersisted: true,
        noInheritance: true,
        revoked: true,
        wire: api.requests.map(({ path, body }) => ({ path, body })),
      },
      null,
      2,
    ),
  );
});

it.each(["openai-completions", "openai-responses"] as const)(
  "matches exact catalog metadata and prices only reported %s counts",
  async (protocol) => {
    const api = await fixture();
    const world = vault();
    const draft = world.vault.customPrepare({
      ...input(api.baseUrl, protocol),
      models: [
        { id: "gpt-4o", context: 65536, output: 1024 },
        { id: "gpt-4o-private", context: 65536, output: 1024 },
      ],
    });
    for (const id of ["gpt-4o", "gpt-4o-private"]) {
      await world.vault.customCheck(draft.draftId ?? "", id);
    }
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const known = runtime
      .getModels()
      .find((model) => model.provider !== account.providerId && model.id === "gpt-4o");
    expect(known).toBeDefined();
    const model = runtime.getModel(account.providerId, "gpt-4o");
    if (!known || !model) throw new Error("Missing catalog fixture model");
    expect(model).toMatchObject({
      name: known.name,
      cost: known.cost,
      contextWindow: 65536,
      maxTokens: 1024,
      reasoning: false,
    });
    const context = {
      messages: [{ role: "user" as const, content: "Synthetic request", timestamp: Date.now() }],
    };
    expect(usageFromMessage(await runtime.completeSimple(model, context))).toEqual({});
    api.highUsage();
    const measured = usageFromMessage(await runtime.completeSimple(model, context));
    expect(measured).toMatchObject({
      input: 60000,
      output: 20,
      cost: (known.cost.input / 1_000_000) * 60000 + (known.cost.output / 1_000_000) * 20,
      costSource: "listed-prices",
    });
    expect(measured?.cacheRead).toBeUndefined();
    expect(measured?.costParts?.cacheRead).toBeUndefined();
    api.highUsage();
    const unmatched = runtime.getModel(account.providerId, "gpt-4o-private");
    if (!unmatched) throw new Error("Missing unmatched fixture model");
    expect(unmatched.name).toBe("gpt-4o-private");
    expect(usageFromMessage(await runtime.completeSimple(unmatched, context))).toEqual({
      input: 60000,
      output: 20,
    });
  },
);

it("offers a connection's models once a checked replacement is applied after a restart that left it without a runtime", async () => {
  const api = await fixture();
  const first = vault();
  const draft = first.vault.customPrepare(input(api.baseUrl));
  await first.vault.customCheck(draft.draftId ?? "", "operator-model");
  const account = await first.vault.customSave(draft.draftId ?? "", false);
  // A restart whose warm-up found the models unchecked (a changed check
  // profile) leaves the account without a runtime, so nothing is offered.
  const restarted = AccountVault.create(first.paths);
  vaults.push(restarted);
  expect(restarted.availableModels()).toEqual([]);
  const replacement = restarted.customPrepare({
    ...input(api.baseUrl),
    replaceAccountId: account.id,
    key: "candidate-synthetic-key",
  });
  await restarted.customCheck(replacement.draftId ?? "", "operator-model");
  await restarted.customSave(replacement.draftId ?? "", false);
  expect(restarted.availableModels().map(({ provider, id }) => ({ provider, id }))).toEqual([
    { provider: account.providerId, id: "operator-model" },
  ]);
});

it("checks a saved connection again in place once its saved checks are an earlier version's, and offers its models", async () => {
  const api = await fixture();
  const first = vault();
  const models = [
    { id: "operator-model", context: 65536, output: 1024 },
    { id: "operator-large-model", context: 65536, output: 1024 },
  ];
  const draft = first.vault.customPrepare({ ...input(api.baseUrl), models });
  for (const model of models) await first.vault.customCheck(draft.draftId ?? "", model.id);
  const account = await first.vault.customSave(draft.draftId ?? "", false);
  // The checks as the release before saved them: same connection, older profile.
  const target = join(first.paths.accountsDir, account.providerId, account.id, "custom-auth.json");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  for (const proof of Object.values(saved.proofs) as { profile: string }[])
    proof.profile = "text-tools-usage-v2";
  writeFileSync(target, JSON.stringify(saved));
  const restarted = AccountVault.create(first.paths);
  vaults.push(restarted);
  expect(restarted.customUnchecked(account.id)).toEqual(["operator-model", "operator-large-model"]);
  expect(restarted.availableModels()).toEqual([]);

  // A refusal stops at the first model, keeps nothing new and says why there.
  api.refuse(503);
  const sentBefore = api.requests.length;
  const refused = await restarted.customRecheck(account.id);
  expect(api.requests.length - sentBefore).toBe(1);
  expect(refused.models.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: "operator-model", state: "incompatible" },
    { id: "operator-large-model", state: "untested" },
  ]);
  expect(refused.models[0]?.failure).toBe(new CustomApiError("server").message);
  expect(restarted.availableModels()).toEqual([]);

  // The fresh check: two requests a model, to the approved address with the saved key.
  api.refuse(200);
  const before = api.requests.length;
  const checked = await restarted.customRecheck(account.id);
  const sent = api.requests.slice(before);
  expect(sent).toHaveLength(6);
  expect(sent.every((request) => request.authorization === "Bearer opaque-synthetic-secret")).toBe(
    true,
  );
  expect(checked.label).toBe(account.label);
  expect(checked.models.map(({ id, state }) => ({ id, state }))).toEqual([
    { id: "operator-model", state: "checked" },
    { id: "operator-large-model", state: "checked" },
  ]);
  expect(restarted.customUnchecked(account.id)).toEqual([]);
  expect(
    restarted
      .availableModels()
      .map(({ provider, id }) => ({ provider, id }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    { provider: account.providerId, id: "operator-large-model" },
    { provider: account.providerId, id: "operator-model" },
  ]);
  // Saved: the next launch finds the connection checked, with no request.
  const relaunched = AccountVault.create(first.paths);
  vaults.push(relaunched);
  expect(relaunched.customUnchecked(account.id)).toEqual([]);
  expect(api.requests.length - before).toBe(6);
});

it("ends a saved connection's fresh check when it is disconnected meanwhile", async () => {
  const api = await fixture();
  const world = vault();
  const draft = world.vault.customPrepare(input(api.baseUrl));
  await world.vault.customCheck(draft.draftId ?? "", "operator-model");
  const account = await world.vault.customSave(draft.draftId ?? "", false);
  const target = join(world.paths.accountsDir, account.providerId, account.id, "custom-auth.json");
  const saved = JSON.parse(readFileSync(target, "utf8"));
  saved.proofs["operator-model"].profile = "text-tools-usage-v2";
  writeFileSync(target, JSON.stringify(saved));
  const restarted = AccountVault.create(world.paths);
  vaults.push(restarted);
  const arrived = api.hold("check");
  const checking = restarted.customRecheck(account.id);
  await arrived;
  await expect(restarted.customRecheck(account.id)).rejects.toThrow("already running");
  restarted.customClose(account.id);
  api.release();
  await expect(checking).rejects.toThrow(new CustomApiError("closed").message);
  expect(JSON.parse(readFileSync(target, "utf8")).proofs["operator-model"].profile).toBe(
    "text-tools-usage-v2",
  );
});

it.each(["openai-completions", "openai-responses"] as const)(
  "a proven %s model receives attachments and all tool-picture results across five rounds",
  async (protocol) => {
    const api = await fixture();
    api.pictures();
    const world = vault();
    const draft = world.vault.customPrepare(input(api.baseUrl, protocol));
    const checked = await world.vault.customCheck(draft.draftId ?? "", "operator-model");
    expect(checked.models[0]).toMatchObject({ checked: true, readsPictures: true });
    const account = await world.vault.customSave(draft.draftId ?? "", false);
    const runtime = await world.vault.runtimeFor(account.id);
    const model = runtime.getModel(account.providerId, "operator-model");
    if (!model) throw new Error("Checked model is missing");
    expect(model.input).toEqual(["text", "image"]);
    const png = { type: "image" as const, data: customPicture(), mimeType: "image/png" };
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Read these captures." }, png],
        timestamp: 0,
      },
    ];
    for (let round = 1; round <= 5; round++) {
      const id = `capture_${round}`;
      messages.push(
        {
          role: "assistant",
          content: [{ type: "toolCall", id, name: "capture_panel", arguments: {} }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: id,
          toolName: "capture_panel",
          content: [{ type: "text", text: `Capture ${round}.` }, png, png],
          isError: false,
          timestamp: 0,
        },
      );
      const reply = await runtime.completeSimple(model, { messages });
      expect(reply.stopReason).toBe("stop");
      const sent = JSON.stringify(api.requests.at(-1)?.body);
      expect(sent.split("data:image/png;base64,").length - 1).toBe(1 + 2 * round);
      expect(sent.split("(tool image omitted: model does not support images)").length - 1).toBe(0);
      console.log(
        "CUSTOM_PICTURE_ROUND",
        JSON.stringify({
          protocol,
          round,
          requestBytes: Buffer.byteLength(sent),
          pictures: 1 + 2 * round,
          olderNotes: 0,
          reply: reply.stopReason,
        }),
      );
    }
    // Restart reads the saved proof without sending any new check.
    const before = api.requests.length;
    const restarted = AccountVault.create(world.paths);
    vaults.push(restarted);
    expect(restarted.customViews()[0]?.models[0]?.readsPictures).toBe(true);
    const restored = await restarted.runtimeFor(account.id);
    expect(restored.getModel(account.providerId, "operator-model")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(api.requests).toHaveLength(before);
    const target = join(
      world.paths.accountsDir,
      account.providerId,
      account.id,
      "custom-auth.json",
    );
    const saved = JSON.parse(readFileSync(target, "utf8"));
    delete saved.proofs["operator-model"].readsPictures;
    writeFileSync(target, JSON.stringify(saved));
    const older = AccountVault.create(world.paths);
    vaults.push(older);
    expect(older.customViews()[0]?.models[0]).toMatchObject({
      checked: true,
      readsPictures: false,
    });
    expect(
      (await older.runtimeFor(account.id)).getModel(account.providerId, "operator-model")?.input,
    ).toEqual(["text"]);
    expect(api.requests).toHaveLength(before);
  },
);
