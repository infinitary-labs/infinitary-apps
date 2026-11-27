import { statSync } from "node:fs";
import { join } from "node:path";
import * as m from "@shared/i18n/messages.generated";
import { STARTER_SLOTS } from "@shared/modelSlots";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { KEYCHAIN_VALUE_FAILURE_THERE } from "@shared/quota";
import { returnsToLoopback, type SignInStep } from "@shared/signIns";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { standInCodex } from "../../../tests/helpers/codexAppServer";
import {
  CLAUDE_ACCESS,
  CLAUDE_CLIENT_ROWS,
  CLAUDE_CODE,
  CLAUDE_CODE_PAGE,
  CODEX_ACCESS,
  joined,
  KEY,
  PASTED_CODE,
  savedText,
  servedThere,
  signInToCodex,
  standInGitHub,
  standInProviders,
  standInSavedPasswords,
} from "../../../tests/helpers/helperSignIns";
import { NO_BROWSER } from "../claude/claudeCli";
import { type ClaudeModelRow, claudeServedModels } from "../claude/claudeModelCatalog";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import { acquireSessionLease } from "../claude/claudeStoreLease";
import { accountWords } from "../codex/savedResets";
import { dialHome } from "../devices/dial";
import { absentKeychain } from "../host";
import { CODEX_MODELS_URL } from "../models/piAccountLists";
import { actualComputerPool } from "../routing/computerPool";
import { route } from "../routing/routingEngine";
import { bindHere, noSignInHere } from "./conversations";
import type { HelperRun } from "./run";

describe("a computer that runs work signs in to its own subscriptions from its home", () => {
  it("lists what it can sign in to only once its home asks, with no sign-in yet", async () => {
    const world = await joined();
    expect(world.group()).toMatchObject({ name: "Mac mini", user: "builder", signIns: null });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.providers.map((p) => p.id))
      .toEqual(expect.arrayContaining(["openai-codex", "xai", "openrouter", "anthropic-claude"]));
    expect(world.group()?.signIns?.accounts).toEqual([]);
    expect(world.group()?.reach).toBe("in-reach");
  });

  it("signs in to OpenRouter with a key typed at home, which the home keeps nowhere", async () => {
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    const asked = await world.prompt(signInId);
    expect(asked.kind).toBe("secret");
    await world.signIns.answer(signInId, asked.promptId, KEY);
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });

    // Its row is in its own group at home, and the feed says it.
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["openrouter"]);
    expect(world.events).toContainEqual(
      expect.objectContaining({
        type: "device_signed_in",
        who: "Builder",
        provider: "OpenRouter",
      }),
    );
    // The key is in the computer's own store, private to it.
    const store = savedText(join(world.dataDir, "accounts")).filter(({ text }) =>
      text.includes(KEY),
    );
    expect(store.map(({ file }) => file)).toEqual([expect.stringMatching(/auth\.json$/)]);
    expect(statSync(store[0]?.file ?? "").mode & 0o777).toBe(0o600);
    // Nothing the home said, pushed or saved holds it.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(KEY);
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(KEY))).toEqual([]);
  });

  it("signs in to Grok with a code read at home, which the computer finishes itself", async () => {
    const asked = standInProviders();
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "xai", "oauth");
    await expect
      .poll(() =>
        world.steps(signInId).find((step) => step.kind === "notice" && step.notice.userCode),
      )
      .toMatchObject({
        notice: { kind: "device_code", userCode: "WXYZ-4242", url: "https://accounts.x.ai/device" },
      });
    // Nobody types anything: the computer polls until the provider says yes.
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    expect(asked.filter(({ url }) => url === "https://auth.x.ai/oauth2/token").length).toBe(2);
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["xai"]);
  });

  it("signs in to Codex with the address the browser ends on pasted back at home, and reads its allowance there", async () => {
    const asked = standInProviders();
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openai-codex", "oauth");
    const method = await world.prompt(signInId);
    expect(method.kind).toBe("select");
    await world.signIns.answer(signInId, method.promptId, "browser");
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice"))
      .toMatchObject({
        notice: { kind: "auth_url", url: expect.stringMatching(/^https:\/\/auth\.openai\.com\//) },
      });
    // Its link sends the browser back to the Mac it opens on, where this
    // computer's sign-in does not wait: the captain pastes that address.
    const link = world
      .steps(signInId)
      .flatMap((step) => (step.kind === "notice" && step.notice.url ? [step.notice.url] : []))[0];
    expect(returnsToLoopback(link)).toBe(true);
    const opened = new URL(link ?? "");
    const endsOn = new URL(opened.searchParams.get("redirect_uri") ?? "");
    endsOn.search = new URLSearchParams({
      code: PASTED_CODE,
      scope: "openid profile email offline_access",
      state: opened.searchParams.get("state") ?? "",
    }).toString();
    const paste = await world.prompt(signInId);
    expect(paste.kind).toBe("manual_code");
    await world.signIns.answer(signInId, paste.promptId, endsOn.toString());
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    // The code inside that address is the one exchanged there.
    expect(
      asked
        .filter(({ url }) => url === "https://auth.openai.com/oauth/token")
        .map(({ body }) => new URLSearchParams(body).get("code")),
    ).toEqual([PASTED_CODE]);

    // The allowance is read on the computer, with its own sign-in, and shown at home.
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    await expect
      .poll(() =>
        world.group()?.signIns?.quota?.providers.find((row) => row.accountId === account.id),
      )
      .toMatchObject({
        status: "ok",
        windows: [expect.objectContaining({ percentRemaining: 88 })],
      });
    expect(world.allowance.asked).toContainEqual({
      url: "https://chatgpt.com/backend-api/wham/usage",
      auth: `Bearer ${CODEX_ACCESS}`,
    });
    expect(JSON.stringify([world.emitted, world.events])).not.toContain(PASTED_CODE);
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(PASTED_CODE))).toEqual([]);

    // A placed conversation binds to that account, and to no other.
    const { accounts } = await world.held();
    const binding = await bindHere(
      { backend: "pi", provider: "openai-codex", accountId: "acct_from_home" },
      accounts,
    );
    expect(binding).toMatchObject({ backend: "pi", accountId: account.id });
    await expect(bindHere({ backend: "pi", provider: "xai" }, accounts)).rejects.toThrow(
      noSignInHere("xai"),
    );
  });

  // INF-4275: a computer's own account keeps going on credits, set from its home.
  it("keeps a computer's own Codex account going on credits from home, saved there, so its spent allowance routes on credits", async () => {
    standInProviders();
    const world = await joined();
    world.allowance.codex.usedPercent = 100;
    world.allowance.codex.credits = { has_credits: true, balance: "12.50" };
    await signInToCodex(world);
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    const row = () =>
      world.group()?.signIns?.quota?.providers.find((entry) => entry.accountId === account.id);
    await expect.poll(() => row()?.credits?.state).toBe("available");
    const onCredits = () => {
      const signIns = world.group()?.signIns ?? null;
      const models = (signIns?.served ?? []).flatMap((served) =>
        served.models.map((model) => ({ ...model, name: model.name ?? model.id })),
      );
      return actualComputerPool("Mac mini", signIns, models, Date.now())?.catalog.some(
        (model) => model.onCredits === true,
      );
    };
    // A computer on this build takes the switch; with it off, nothing serves on credits.
    expect(world.group()?.keepGoing).toBe(true);
    expect(onCredits()).toBe(false);
    // Codex refused a turn there: the spent allowance is held until its reset.
    const { accounts } = await world.held();
    accounts.vault.noteCutOff(account.id, {
      class: "no_headroom",
      resetsAt: Date.now() + 3_600_000,
    });

    await world.signIns.keepGoing(world.deviceId, account.id, true);
    // Its credits answer, so the switch ends that hold there at once.
    expect(accounts.vault.cutOff(account.id)).toBeUndefined();
    expect(world.group()?.signIns?.accounts.find((entry) => entry.id === account.id)).toMatchObject(
      { keepGoingOnCredits: true },
    );
    expect(row()?.keepGoingOnCredits).toBe(true);
    expect(onCredits()).toBe(true);
    expect(
      savedText(world.dataDir).some(({ text }) => text.includes('"keepGoingOnCredits": true')),
    ).toBe(true);
    expect(
      savedText(world.homeDir).filter(({ text }) => text.includes("keepGoingOnCredits")),
    ).toEqual([]);

    await world.signIns.keepGoing(world.deviceId, account.id, false);
    expect(row()?.keepGoingOnCredits).toBeUndefined();
    expect(onCredits()).toBe(false);
    await expect(world.signIns.keepGoing(world.deviceId, "acct_elsewhere", true)).rejects.toThrow(
      "Builder has no account with that id.",
    );
  });

  // INF-5478's plan, piece 1: a computer's own Codex account's saved reset is
  // used there, by that computer's Codex, with its sign-in's link at home.
  it("uses a computer's own saved Codex reset there, Codex's sign-in link shown at home, and reads its allowance again", async () => {
    standInProviders();
    // Codex there keeps no sign-in for the account yet; the Codex account id matches the computer's own sign-in's.
    const codex = standInCodex({ signedIn: false, accountId: "acct-standin" });
    const world = await joined({ codex });
    await signInToCodex(world);
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    expect(world.group()?.savedReset).toBe(true);
    const reads = world.allowance.asked.length;

    // Without a sign-in asked for, it is refused there and nothing is used.
    await expect(world.signIns.redeemSavedReset(world.deviceId, account.id, false)).rejects.toThrow(
      m.accountsSavedResetSignInFirst({ account: accountWords(account) }),
    );
    expect(codex.methods()).not.toContain("account/rateLimitResetCredit/consume");

    const used = world.signIns.redeemSavedReset(world.deviceId, account.id, true);
    await expect(used).resolves.toEqual({ outcome: "used", left: 1 });
    // Codex's own sign-in link reached the home as a step of the account's flow.
    expect(
      world
        .signInIds()
        .flatMap((id) => world.steps(id))
        .some(
          (step) =>
            step.kind === "notice" && step.notice.url?.startsWith("https://auth.openai.com/"),
        ),
    ).toBe(true);
    expect(codex.homes.every((home) => home?.startsWith(world.dataDir))).toBe(true);
    expect(codex.homes.every((home) => home?.includes(account.id))).toBe(true);
    // Its allowance is read there again, and that reading reaches the home.
    await expect.poll(() => world.allowance.asked.length).toBeGreaterThan(reads);
  });

  // INF-4280's audit, fix 1: a computer's own account is renamed, paused and preferred from its home.
  it("renames, pauses and prefers a computer's own Codex account from home, saved only there, so its routing there follows", async () => {
    standInProviders();
    const world = await joined();
    await signInToCodex(world);
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    const seen = () => world.group()?.signIns?.accounts.find((row) => row.id === account.id);
    const pooled = () => {
      const signIns = world.group()?.signIns ?? null;
      const models = (signIns?.served ?? []).flatMap((served) =>
        served.models.map((model) => ({ ...model, name: model.name ?? model.id })),
      );
      return actualComputerPool("Mac mini", signIns, models, Date.now())?.catalog.length ?? 0;
    };
    await expect.poll(pooled).toBeGreaterThan(0);
    expect(world.group()?.accountSettings).toBe(true);

    await world.signIns.setAccount(world.deviceId, {
      kind: "rename",
      accountId: account.id,
      label: "Studio Codex",
    });
    expect(seen()?.label).toBe("Studio Codex");
    await world.signIns.setAccount(world.deviceId, {
      kind: "pin",
      providerId: "openai-codex",
      accountId: account.id,
    });
    expect(seen()?.pinned).toBe(true);
    // Paused there, its models leave that computer's routing; its sign-in stays.
    await world.signIns.setAccount(world.deviceId, {
      kind: "set-enabled",
      accountId: account.id,
      enabled: false,
    });
    expect(seen()).toMatchObject({ enabled: false, connected: true });
    expect(pooled()).toBe(0);
    expect(savedText(world.dataDir).some(({ text }) => text.includes("Studio Codex"))).toBe(true);
    expect(savedText(world.homeDir).filter(({ text }) => text.includes("Studio Codex"))).toEqual(
      [],
    );

    await world.signIns.setAccount(world.deviceId, {
      kind: "set-enabled",
      accountId: account.id,
      enabled: true,
    });
    await expect.poll(pooled).toBeGreaterThan(0);
    await expect(
      world.signIns.setAccount(world.deviceId, {
        kind: "set-enabled",
        accountId: "acct_elsewhere",
        enabled: false,
      }),
    ).rejects.toThrow("Builder has no account with that id.");
  });

  // INF-4280's audit, fix 3: Refresh asks each computer to read its allowance now, not at its next tick.
  it("has a computer read its own allowance now when the home refreshes", async () => {
    standInProviders();
    const world = await joined();
    await signInToCodex(world);
    const left = () =>
      world.group()?.signIns?.quota?.providers.find((row) => row.provider === "codex")?.windows[0]
        ?.percentRemaining;
    await expect.poll(left).toBe(100 - world.allowance.codex.usedPercent);
    const usage = () =>
      world.allowance.asked.filter((ask) => ask.url.endsWith("/wham/usage")).length;
    const before = usage();
    world.allowance.codex.usedPercent = 64;

    await world.signIns.readAllowance();
    expect(usage()).toBe(before + 1);
    expect(left()).toBe(36);
  });

  it("signs a computer out of one of its own accounts from home", async () => {
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    await world.signIns.answer(signInId, (await world.prompt(signInId)).promptId, KEY);
    await world.ended(signInId);
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });
    await world.signIns.signOut(world.deviceId, account.id);
    await expect.poll(() => world.group()?.signIns?.accounts).toEqual([]);
    expect(savedText(world.dataDir).filter(({ text }) => text.includes(KEY))).toEqual([]);
    expect(world.events).toContainEqual({
      type: "device_signed_out",
      deviceId: world.deviceId,
      who: "Builder",
      provider: "OpenRouter",
    });
  });

  it("signs the computer out of the Claude login Firstmate made there when the home signs it out of Claude", async () => {
    const world = await joined({ claudeLogin: "absent" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    await world.signIns.answer(signInId, (await world.prompt(signInId)).promptId, CLAUDE_CODE);
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });

    await world.signIns.signOut(world.deviceId, account.id);
    await expect.poll(() => world.group()?.signIns?.accounts).toEqual([]);
    expect(world.claude.logouts).toBe(1);
    expect(world.claude.loggedIn).toBe(false);
    expect(world.events).toContainEqual({
      type: "device_signed_out",
      deviceId: world.deviceId,
      who: "Builder",
      provider: "Claude",
      login: "signed-out",
    });
  });

  it("leaves the Claude login that was there before when the home signs the computer out of Claude", async () => {
    const world = await joined({ claudeLogin: "live" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });

    await world.signIns.signOut(world.deviceId, account.id);
    await expect.poll(() => world.group()?.signIns?.accounts).toEqual([]);
    expect(world.claude.logouts).toBe(0);
    expect(world.claude.loggedIn).toBe(true);
    expect(world.events).toContainEqual({
      type: "device_signed_out",
      deviceId: world.deviceId,
      who: "Builder",
      provider: "Claude",
      login: "kept",
    });
  });

  it("adopts the Claude login already there, and asks for nothing", async () => {
    const live = await joined({ claudeLogin: "live" });
    const adopted = await live.signIns.start(live.deviceId, "anthropic-claude", "oauth");
    expect(await live.ended(adopted.signInId)).toMatchObject({ outcome: "signed-in" });
    expect(live.steps(adopted.signInId).some((step) => step.kind === "prompt")).toBe(false);
    expect(live.claude.browser).toEqual([]);
  });

  it("offers an Automatic start there the Claude models it serves once signed in to Claude", async () => {
    const world = await joined({ claudeLogin: "live" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    // The home's catalog lists Claude's models whether or not anything there serves them.
    const catalog = CLAUDE_MODELS.map((model) => ({ provider: CLAUDE_PROVIDER_ID, ...model }));
    const pool = () =>
      actualComputerPool("Mac mini", world.group()?.signIns ?? null, catalog, Date.now());
    await expect.poll(() => pool()?.available.length ?? 0).toBeGreaterThan(0);
    const chosen = pool();
    const { choice } = route({
      catalog: chosen?.catalog ?? [],
      available: chosen?.available ?? [],
      pins: [],
      bucket: "medium",
    });
    expect(choice?.provider).toBe(CLAUDE_PROVIDER_ID);
    // It runs there on that computer's own Claude account.
    const account = world
      .group()
      ?.signIns?.accounts.find((row) => row.providerId === CLAUDE_PROVIDER_ID);
    expect(chosen?.modelAccounts.get(`${choice?.provider}/${choice?.id}`)).toBe(account?.id);
  });

  // FI3-1806: a computer that runs work builds its model lists as the home
  // does, so an Automatic start routes among what it actually serves.
  it("lists the Claude models that computer's own client answers, as the home lists its own", async () => {
    const rows: ClaudeModelRow[] = [
      ...CLAUDE_CLIENT_ROWS.filter((row) => row.resolvedModel !== "claude-fable-5-1"),
      { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
    ];
    const world = await joined({ claudeLogin: "live", claudeModels: rows });
    const { signInId } = await world.signIns.start(world.deviceId, CLAUDE_PROVIDER_ID, "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    await expect
      .poll(() => servedThere(world, CLAUDE_PROVIDER_ID))
      .toEqual(
        claudeServedModels(rows)
          .map((model) => model.id)
          .sort(),
      );
  });

  it("serves only the Codex models the account's own list names there, behind the home's rail", async () => {
    // Pi stays offline; the list is read at Codex's own address, which the stand-in answers.
    vi.stubEnv("INFINITARY_CODEX_MODELS_URL", CODEX_MODELS_URL);
    standInProviders();
    // The account's list names every starter row, and a model Pi has no definition for.
    const starters = Object.keys(STARTER_SLOTS["openai-codex"] ?? {});
    const world = await joined({ codexModels: [...starters, "gpt-7-preview"] });
    await signInToCodex(world);
    await expect.poll(() => servedThere(world, "openai-codex")).toEqual([...starters].sort());
  });

  // INF-84's review of FI3-1806: the rail protects what the captain kept, there as here.
  it("keeps a Codex model the captain pinned listed there when the account's own list leaves it out", async () => {
    vi.stubEnv("INFINITARY_CODEX_MODELS_URL", CODEX_MODELS_URL);
    standInProviders();
    const starters = Object.keys(STARTER_SLOTS["openai-codex"] ?? {});
    const world = await joined({ codexModels: starters });
    await signInToCodex(world);
    // The list there names only the starter rows, so it narrows every other model away.
    await expect.poll(() => servedThere(world, "openai-codex")).toEqual([...starters].sort());
    // The captain pins a model Pi serves that account, the way Models settings saves a pin.
    const { accounts } = await world.held();
    const account = accounts.vault.list().find((row) => row.providerId === "openai-codex");
    const pinned = accounts.vault
      .piCatalogIds(account?.id ?? "")
      ?.find((id) => !starters.includes(id));
    if (!pinned) throw new Error("Pi serves that account no model beyond its starter rows.");
    world.settings.setRoutingSettings({
      ...world.settings.getRoutingSettings(),
      pins: [{ provider: "codex", id: pinned }],
    });
    // A list that leaves out a kept model is not trusted to narrow anything, as here.
    expect(servedThere(world, "openai-codex")).toContain(pinned);
  });

  // INF-84's review of FI3-1806: a list read is tried again once a day, as here.
  it("asks Claude's client there for its model list at a sign-in, and not again with each allowance reading", async () => {
    const world = await joined({ claudeLogin: "live", claudeModels: "no answer" });
    const { signInId } = await world.signIns.start(world.deviceId, CLAUDE_PROVIDER_ID, "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    // The read settled as a failure, and the shipped catalog serves.
    await expect
      .poll(() =>
        world.logs.some((line) => line.startsWith(`${CLAUDE_PROVIDER_ID} model list unavailable`)),
      )
      .toBe(true);
    const { accounts } = await world.held();
    await accounts.readAllowance("interval");
    await accounts.readAllowance("interval");
    expect(world.claude.listReads).toBe(1);
  });

  // INF-142's review of FI3-1806: a read that waited on the store is no try.
  it("reads Claude's model list there once a session there lets go of the login's store", async () => {
    const world = await joined({ claudeLogin: "live" });
    // A crewmate's Claude session there holds the login's store, so a list read there waits.
    const release = await acquireSessionLease(world.claudeDir);
    const { signInId } = await world.signIns.start(world.deviceId, CLAUDE_PROVIDER_ID, "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const { accounts } = await world.held();
    const account = accounts.vault.list().find((row) => row.providerId === CLAUDE_PROVIDER_ID);
    if (!account) throw new Error("The computer kept no Claude account.");
    // The ended message precedes the sign-in's model-list and allowance work.
    // Keep the lease until that work finishes, not merely until the message arrives.
    await expect.poll(() => world.claude.allowanceReads.includes("sign-in")).toBe(true);
    expect(world.claude.listReads).toBe(0);
    // The session ends; the next allowance reading asks Claude's client for its list.
    release();
    await accounts.readAllowance("interval");
    await expect.poll(() => world.claude.listReads).toBe(1);
  });

  it("adopts the Claude login kept in that computer's saved passwords, and starts no sign-in over it", async () => {
    const saved = standInSavedPasswords({ allows: false });
    const world = await joined({ claudeLogin: "live", keychain: saved.keychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["anthropic-claude"]);

    // No code was asked at home, and no sign-in ran there to replace the login.
    expect(world.steps(signInId).some((step) => step.kind === "prompt")).toBe(false);
    expect(world.claude.browser).toEqual([]);
    expect(world.claude.pasted).toEqual([]);
    // It looked in that computer's saved passwords, and never let macOS ask.
    expect(saved.queries.length).toBeGreaterThan(0);
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
  });

  it("asks Claude Code there before a new sign-in, and uses the login it says it has", async () => {
    // Nothing this computer reads shows the login, but Claude Code there is signed in.
    const world = await joined({ claudeLogin: "live", keychain: absentKeychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    expect(world.steps(signInId).some((step) => step.kind === "prompt")).toBe(false);
    expect(world.claude.browser).toEqual([]);
  });

  it("signs in to Claude with a link opened at home and the code it shows pasted back", async () => {
    const world = await joined({ claudeLogin: "absent" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    // The link goes home, to open in the captain's browser there.
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice" && step.notice.url))
      .toMatchObject({ notice: { kind: "auth_url", url: CLAUDE_CODE_PAGE } });
    const paste = await world.prompt(signInId);
    expect(paste.kind).toBe("manual_code");
    await world.signIns.answer(signInId, paste.promptId, CLAUDE_CODE);
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });

    // Claude's client there took the code once, and opened no browser there.
    expect(world.claude.pasted).toEqual([CLAUDE_CODE]);
    expect(world.claude.browser).toEqual([NO_BROWSER]);
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["anthropic-claude"]);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: "device_signed_in", who: "Builder", provider: "Claude" }),
    );
    // Nothing the home said, pushed or saved holds the code.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      CLAUDE_CODE,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(CLAUDE_CODE))).toEqual([]);
  });

  it("says Claude's own words when the pasted code is refused, and signs nothing in", async () => {
    const world = await joined({ claudeLogin: "absent" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    await world.signIns.answer(signInId, (await world.prompt(signInId)).promptId, "wrong");
    expect(await world.ended(signInId)).toMatchObject({
      outcome: "failed",
      error: "Login failed: Invalid authorization code",
    });
    expect(world.group()?.signIns?.accounts ?? []).toEqual([]);
  });

  it("reads Claude's allowance there with that computer's own login, and asks macOS nothing", async () => {
    const saved = standInSavedPasswords({ allows: true });
    const world = await joined({ claudeLogin: "live", keychain: saved.keychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });

    // The reading lands at home in the account's row, read with the login there.
    await expect
      .poll(() =>
        world.group()?.signIns?.quota?.providers.find((row) => row.accountId === account.id),
      )
      .toMatchObject({
        provider: "claude",
        status: "ok",
        windows: [expect.objectContaining({ percentRemaining: 73 })],
      });
    expect(world.allowance.asked).toContainEqual({
      url: "https://api.anthropic.com/api/oauth/usage",
      auth: `Bearer ${CLAUDE_ACCESS}`,
    });
    // Neither the sign-in nor the reading let macOS ask on that screen.
    expect(saved.queries.length).toBeGreaterThan(0);
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
    // The login stays there: nothing the home heard or saved holds it.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      CLAUDE_ACCESS,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(CLAUDE_ACCESS))).toEqual([]);
  });

  it("says at home why Claude's allowance is not read there when macOS would have to ask", async () => {
    const saved = standInSavedPasswords({ allows: false });
    const world = await joined({ claudeLogin: "live", keychain: saved.keychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });
    const row = () =>
      world.group()?.signIns?.quota?.providers.find((entry) => entry.accountId === account.id);

    // Not "reading" with no end: the row says why, in words for a computer.
    await expect.poll(row).toMatchObject({
      status: "unavailable",
      reason: "keychain_needs_grant",
      detail: KEYCHAIN_VALUE_FAILURE_THERE.keychain_needs_grant,
      windows: [],
    });
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
    expect(world.allowance.asked.map((asked) => asked.url)).not.toContain(
      "https://api.anthropic.com/api/oauth/usage",
    );

    // The refusal is not held: once macOS there lets it read, the next reading shows.
    saved.allow();
    await (await world.held()).accounts.readAllowance("interval");
    await expect.poll(row).toMatchObject({
      status: "ok",
      windows: [expect.objectContaining({ percentRemaining: 73 })],
    });
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
  });

  it("stops a sign-in when the home stops it, and when the computer goes out of reach", async () => {
    const world = await joined();
    const first = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    await world.prompt(first.signInId);
    await world.signIns.cancel(first.signInId);
    expect(await world.ended(first.signInId)).toMatchObject({ outcome: "cancelled" });

    const second = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    const asked = await world.prompt(second.signInId);
    // The connection goes: nobody can answer it there now.
    await world.connection.close();
    expect(await world.ended(second.signInId)).toMatchObject({
      outcome: "failed",
      error: "Builder went out of reach, so the sign-in stopped.",
    });
    await expect(world.signIns.answer(second.signInId, asked.promptId, KEY)).rejects.toThrow(
      "no longer running",
    );
    await expect(world.signIns.start(world.deviceId, "openrouter", "api_key")).rejects.toThrow(
      "Builder is out of reach, so no sign-in started.",
    );
    expect(world.group()?.signIns?.accounts).toEqual([]);
  });

  it("replaces an account flow from overlapping callers on the computer, not just in Settings", async () => {
    const computerSteps: { signInId: string; step: SignInStep }[] = [];
    const world = await joined({
      onStep: (signInId, step) => computerSteps.push({ signInId, step }),
    });
    const pending = world.signIns.start(world.deviceId, "openrouter", "api_key");
    const replacement = world.signIns.start(world.deviceId, "openrouter", "api_key");
    const [first, second] = await Promise.all([pending, replacement]);
    await expect
      .poll(() =>
        computerSteps
          .filter((event) => event.signInId === first.signInId && event.step.kind === "ended")
          .map((event) => event.step),
      )
      .toEqual([{ kind: "ended", outcome: "cancelled" }]);
    expect(world.group()?.flows?.map((flow) => flow.signInId)).toEqual([second.signInId]);
    await world.signIns.answer(
      second.signInId,
      (await world.prompt(second.signInId)).promptId,
      KEY,
    );
    expect(await world.ended(second.signInId)).toMatchObject({ outcome: "signed-in" });
    expect((await (await world.held()).accounts.vault.views()).length).toBe(1);
  });

  // Reconnect must release the computer's work, not only the home's view.
  it.each(["account", "forge"] as const)(
    "cancels the computer's %s flow through a real quick redial and permits a fresh sign-in",
    async (target) => {
      const github = target === "forge" ? standInGitHub({ hold: true }) : undefined;
      const sockets: WebSocket[] = [];
      const contactsAtDial: (string | undefined)[] = [];
      const computerSteps: { signInId: string; step: SignInStep }[] = [];
      let state: (() => ReturnType<HelperRun["state"]>) | undefined;
      const world = await joined({
        dial: async (grant) => {
          contactsAtDial.push(state?.().contact);
          const socket = await dialHome(grant);
          sockets.push(socket);
          return socket;
        },
        onStep: (signInId, step) => computerSteps.push({ signInId, step }),
      });
      state = world.state;
      world.signIns.read();
      await expect.poll(() => world.group()?.signIns?.forges?.hosts.length).toBe(1);
      const start = () =>
        target === "account"
          ? world.signIns.start(world.deviceId, "openrouter", "api_key")
          : world.signIns.startForge(world.deviceId, "github.com");
      const first = await start();
      const prompt = target === "account" ? await world.prompt(first.signInId) : undefined;
      if (target === "forge")
        await expect
          .poll(() => world.steps(first.signInId).some((step) => step.kind === "notice"))
          .toBe(true);
      const socket = sockets.at(-1);
      if (!socket) throw new Error("The computer has no connected socket");
      socket.terminate();
      await expect
        .poll(() =>
          computerSteps
            .filter((event) => event.signInId === first.signInId && event.step.kind === "ended")
            .map((event) => event.step),
        )
        .toEqual([{ kind: "ended", outcome: "cancelled" }]);
      expect(contactsAtDial).toEqual([undefined, "in-reach"]);
      expect(world.state().contact).toBe("in-reach");
      expect(world.group()?.flows?.[0]).toMatchObject({
        signInId: first.signInId,
        phase: "ended",
        ended: { outcome: "failed" },
      });
      const held = await world.held();
      await held.accounts.vault.swept();
      expect(await held.accounts.vault.views()).toEqual([]);
      expect(held.forges.view().signIns).toEqual([]);
      if (prompt)
        await expect(
          held.host.answer("inf:sign-ins:answer", [
            { signInId: first.signInId, promptId: prompt.promptId, value: KEY },
          ]),
        ).rejects.toThrow("no longer waiting");
      const second = await start();
      if (target === "account")
        await world.signIns.answer(
          second.signInId,
          (await world.prompt(second.signInId)).promptId,
          KEY,
        );
      else github?.approve();
      expect(await world.ended(second.signInId)).toMatchObject({ outcome: "signed-in" });
      expect(world.events.filter((event) => event.type === "device_signed_in")).toHaveLength(1);
    },
  );

  it("answers a sign-in step only from the computer it runs on", async () => {
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    expect(() =>
      world.signIns.step("another-device", {
        signInId,
        step: { kind: "ended", outcome: "signed-in" },
      }),
    ).toThrow("No sign-in of this home runs on that computer.");
    expect(() =>
      world.signIns.changed("another-device", { providers: [], accounts: [], quota: null }),
    ).toThrow("No computer that runs work has that id");
  });
});
