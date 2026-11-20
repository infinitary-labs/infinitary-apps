import { expect, test } from "@playwright/test";
import { FIRSTMATE_FAILURE_TITLE } from "../../src/core/orchestrator/hostCards";
import {
  keptMessageWords,
  seatPausedLine,
  signedOutSentence,
} from "../../src/core/orchestrator/seat";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { classifyBedrockCode } from "../../src/shared/authFailure";
import { placementNamedModelWait } from "../../src/shared/placement";
import {
  BEDROCK_PROFILE_UNAVAILABLE,
  BEDROCK_PROVIDER_ID,
  BEDROCK_SIGN_IN,
  catalogEntry,
} from "../../src/shared/providers";
import { formatBedrockSpend } from "../../src/shared/quota";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { bubbleWords, mateBubble } from "./lastTurn";
import { launchApp } from "./launch";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockModels";
import { CLASSIFY_CHORE_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { served } from "./providerRequest";
import { feedLine, startedLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import {
  BEDROCK_CREW_RESULT,
  BEDROCK_CREW_TITLE,
  BEDROCK_CREW_WORDS,
  BEDROCK_FIXTURE_USAGE,
  BEDROCK_KEY,
  BEDROCK_MODEL,
  BEDROCK_PROFILE,
  BEDROCK_REPLY,
  bedrockLoginExecutable,
  DENIED_BEDROCK_MODEL,
  installBedrockProfile,
  PROFILE_KEY_ID,
  RECOVERED_BEDROCK_MODEL,
  ROTATED_PROFILE_KEY_ID,
  removeBedrockProfile,
  SHARED_BEDROCK_ROWS,
  seedSharedBedrockRows,
  startBedrockStandIn,
} from "./scenarios/bedrock";
import { closeOpenCards, showCard } from "./stack";
import { pressKey } from "./windowKeys";

const name = catalogEntry(BEDROCK_PROVIDER_ID)?.name ?? BEDROCK_PROVIDER_ID;

test("a connected Bedrock account serves checked Claude models and shows a refused key (INF-3451)", async () => {
  const aws = await startBedrockStandIn();
  const env = {
    INFINITARY_BEDROCK_TEST_URL: aws.url,
    AWS_BEARER_TOKEN_BEDROCK: "ambient-not-connected",
    AWS_BEDROCK_SKIP_AUTH: "1",
    AWS_REGION: "eu-west-1",
  };
  let launched = await launchApp({ env }).catch(async (error: unknown) => {
    await aws.close();
    throw error;
  });
  try {
    let { page } = launched;
    expect(aws.calls).toEqual([]);
    await pressKey(page.getByRole("button", { name: new RegExp(name), exact: false }), "Enter");
    await pressKey(page.getByRole("button", { name: BEDROCK_SIGN_IN.key, exact: true }), "Enter");
    await page.getByPlaceholder(BEDROCK_SIGN_IN.regionExample).fill(BEDROCK_SIGN_IN.regionExample);
    await pressKey(page.getByPlaceholder(BEDROCK_SIGN_IN.regionExample), "Enter");
    const key = page.getByPlaceholder(BEDROCK_SIGN_IN.key);
    await key.fill(BEDROCK_KEY);
    await pressKey(key, "Enter");
    await expect
      .poll(() => aws.calls.find((call) => call.model === BEDROCK_MODEL && call.check)?.signed)
      .toBe(true);
    await expect(promptInput(page)).toBeEnabled();
    const { userDataDir, homeDir } = launched;
    const checks = aws.calls.filter((call) => call.check).length;
    expect(checks).toBeGreaterThan(1);
    await launched.close();
    launched = await launchApp({ userDataDir, homeDir, env });
    page = launched.page;
    const input = promptInput(page);
    await expect(input).toBeEnabled();
    expect(aws.calls.filter((call) => call.check)).toHaveLength(checks);
    await input.fill("Reply to this test message.");
    await pressKey(input, "Enter");
    const reply = bubbleWords(mateBubble(page));
    await expect(reply).toHaveText(BEDROCK_REPLY);
    await expect(reply).toBeVisible();
    expect(
      aws.calls
        .filter((call) => !call.check)
        .every((call) => call.model === BEDROCK_MODEL && call.signed),
    ).toBe(true);
    const account = (await page.evaluate(() => window.infinitary.accounts.list())).find(
      (row) => row.providerId === BEDROCK_PROVIDER_ID,
    );
    if (!account) throw new Error("The connected Bedrock key has no account row.");
    const { inputTokens, outputTokens } = BEDROCK_FIXTURE_USAGE;
    // Auxiliary model work can share this account. Reconcile the wire responses,
    // the account's ledger, and the displayed estimate, not the number of replies.
    const expectSpend = async (
      status: "not_measured" | "auth_required",
      unchangedSince?: number,
    ) => {
      let served = 0;
      await expect(async () => {
        const row = await page.evaluate(async (id) => {
          const snapshot = await window.infinitary.quota.refresh();
          return snapshot?.providers.find((entry) => entry.accountId === id);
        }, account.id);
        served = aws.servedInference();
        expect(served).toBeGreaterThan(0);
        if (unchangedSince !== undefined) expect(served).toBe(unchangedSince);
        const expectedCost = (served * (inputTokens * 2.2 + outputTokens * 11)) / 1_000_000;
        expect(
          readSavedData(userDataDir, (db) =>
            db
              .prepare(`SELECT COUNT(*) AS rows, COUNT(cost) AS priced,
                  SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost
                FROM usage_events WHERE account_id = ? AND provider = ?`)
              .get(account.id, BEDROCK_PROVIDER_ID),
          ),
        ).toEqual({
          rows: served,
          priced: served,
          input: served * inputTokens,
          output: served * outputTokens,
          cost: expect.closeTo(expectedCost, 8),
        });
        expect(row).toMatchObject({
          status,
          windows: [],
          detail: formatBedrockSpend(expectedCost, false),
        });
      })
        .toPass({ timeout: 5_000 })
        .catch(async (error: unknown) => {
          // Include unbound and misattributed Bedrock rows, not just the rows in the estimate.
          const rows = readSavedData(userDataDir, (db) =>
            db
              .prepare(`SELECT id, at, task_id, account_id = ? AS matched_account,
                  model, input, output, cost, cost_source
                FROM usage_events WHERE provider = ? ORDER BY id`)
              .all(account.id, BEDROCK_PROVIDER_ID),
          );
          await test.info().attach("bedrock-spend-reconciliation", {
            contentType: "application/json",
            body: JSON.stringify(
              { status, unchangedSince, responses: aws.inferenceResponses, rows },
              null,
              2,
            ),
          });
          throw error;
        });
      return served;
    };
    await waitForFirstmateIdle(page);
    const beforeRefusals = await expectSpend("not_measured");
    for (const refusal of ["AccessDeniedException", "bare-403", "ThrottlingException"] as const) {
      const before = aws.calls.length;
      aws.refuse(refusal);
      await input.fill(`Try the named AWS refusal ${refusal}.`);
      await pressKey(input, "Enter");
      await expect.poll(() => aws.calls.length).toBeGreaterThan(before);
      const { error } = classifyBedrockCode(refusal === "bare-403" ? undefined : refusal);
      // A refusal can update the stack without selecting its card.
      await expect
        .poll(() =>
          page.evaluate(async (title) => {
            const cards = await window.infinitary.cards.list();
            return cards.find((card) => card.title === title)?.body;
          }, FIRSTMATE_FAILURE_TITLE),
        )
        .toContain(error);
      await showCard(page, FIRSTMATE_FAILURE_TITLE);
      await expect(
        cardBody(page, FIRSTMATE_FAILURE_TITLE).getByText(error, { exact: false }).first(),
      ).toBeVisible();
      if (refusal === "ThrottlingException")
        await expect.poll(() => aws.calls.length).toBeGreaterThan(before + 1);
      await expect(input).toBeEnabled();
      await waitForFirstmateIdle(page);
      await expectSpend("not_measured", beforeRefusals);
      const rows = await page.evaluate(() => window.infinitary.accounts.list());
      expect(rows.find((row) => row.providerId === BEDROCK_PROVIDER_ID)?.cutOff?.class).not.toBe(
        "signed_out",
      );
    }
    aws.refuse(undefined);
    await page.evaluate(
      (offering) =>
        window.infinitary.models.setDecisions({
          version: 1,
          answerer: { kind: "adapted", offering },
          egress: {},
        }),
      `${BEDROCK_PROVIDER_ID}/${BEDROCK_MODEL}`,
    );
    const beforeCrew = aws.calls.length;
    await input.fill(BEDROCK_CREW_WORDS);
    await pressKey(input, "Enter");
    await expect(startedLine(page, await taskKey(page, BEDROCK_CREW_TITLE))).toBeVisible();
    await expect
      .poll(() =>
        aws.calls
          .slice(beforeCrew)
          .filter((call) => call.signed && call.model === BEDROCK_MODEL)
          .map((call) => call.role),
      )
      .toEqual(expect.arrayContaining(["decision", "crew"]));
    await expect
      .poll(() =>
        readSavedData(userDataDir, (db) => {
          const task = db
            .prepare("SELECT shape_json, outcome FROM task_records WHERE title = ?")
            .get(BEDROCK_CREW_TITLE) as { shape_json: string; outcome: string | null } | undefined;
          return task && { shape: JSON.parse(task.shape_json), outcome: task.outcome };
        }),
      )
      .toMatchObject({
        shape: {
          kind: "research",
          kind_source: `classifier:${BEDROCK_PROVIDER_ID}/${BEDROCK_MODEL}`,
        },
        outcome: BEDROCK_CREW_RESULT,
      });
    await waitForFirstmateIdle(page);
    const beforeExpiry = await expectSpend("not_measured");
    aws.refuse("ExpiredTokenException");
    await input.fill("Try the lapsed AWS sign-in.");
    await pressKey(input, "Enter");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const rows = await window.infinitary.accounts.list();
          return rows.find((row) => row.providerId === "amazon-bedrock")?.cutOff?.class;
        }),
      )
      .toBe("signed_out");
    await expect
      .poll(() => page.evaluate(async () => (await window.infinitary.models.decisions()).pinned))
      .toBe("fallback");
    const signedOut = signedOutSentence(account.label);
    await expect(feedLine(page, seatPausedLine("signed_out", signedOut, name))).toBeVisible();
    await waitForFirstmateIdle(page);
    await expectSpend("auth_required", beforeExpiry);
    const afterRefusal = aws.calls.length;
    await closeOpenCards(page);
    await input.fill("Keep this follow-up until I sign in again.");
    await pressKey(input, "Enter");
    await expect(feedLine(page, keptMessageWords(signedOut, "signed_out", name))).toBeVisible();
    await waitForFirstmateIdle(page);
    expect(aws.calls).toHaveLength(afterRefusal);
    await launched.close();
    launched = await launchApp({ userDataDir, homeDir, env, withMockProvider: true });
    page = launched.page;
    const fallback = launched.mockProvider;
    if (!fallback) throw new Error("The held-route journey needs a fallback provider.");
    const offering = `${BEDROCK_PROVIDER_ID}/${BEDROCK_MODEL}`;
    const mockSeat = { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID };
    await expect(
      page.evaluate((model) => window.infinitary.settings.setFirstmateModel(model), mockSeat),
    ).resolves.toEqual(mockSeat);
    await expect(promptInput(page)).toBeEnabled();
    const decisionTitle = "Fallback decision check";
    const pinnedTitle = "Withheld Bedrock crew check";
    const dispatch = async (title: string, pin?: string) => {
      const words = `Please ${CLASSIFY_CHORE_MARKER} for ${title}.`;
      await waitForFirstmateIdle(page);
      const scripted = fallback.scriptFirstmateTurn(
        served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
        [
          {
            name: "spawn_crewmate",
            args: {
              title,
              goal: words,
              user_words: words,
              shape: { rigor_ask: "quick", ...(pin ? { override_model_id: pin } : {}) },
            },
          },
        ],
      );
      const composer = promptInput(page);
      await composer.fill(words);
      await pressKey(composer, "Enter");
      await expect.poll(scripted.outcome).toMatchObject({ state: "closed" });
    };
    const savedShape = (title: string) =>
      readSavedData(userDataDir, (db) => {
        const row = db.prepare("SELECT shape_json FROM task_records WHERE title = ?").get(title) as
          | { shape_json: string | null }
          | undefined;
        return row?.shape_json
          ? (JSON.parse(row.shape_json) as Record<string, unknown>)
          : undefined;
      });
    await dispatch(decisionTitle);
    await expect
      .poll(() => savedShape(decisionTitle))
      .toMatchObject({
        kind: "chore",
        kind_source: `classifier:${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
      });
    await dispatch(pinnedTitle, offering);
    await expect
      .poll(() => savedShape(pinnedTitle))
      .toMatchObject({ placement_wait: { words: placementNamedModelWait(offering) } });
    const selection = await page.evaluate(async (provider) => {
      const decisions = await window.infinitary.models.decisions();
      const accounts = await window.infinitary.accounts.list();
      return {
        answerer: decisions.settings.answerer,
        held: accounts.find((account) => account.providerId === provider)?.cutOff?.class,
      };
    }, BEDROCK_PROVIDER_ID);
    expect(selection).toEqual({ answerer: { kind: "adapted", offering }, held: "signed_out" });
    expect(aws.calls).toHaveLength(afterRefusal);
  } finally {
    await launched.close();
    await aws.close();
  }
});

test("a named Bedrock profile that cannot resolve offers recovery without claiming expiry (INF-3451)", async () => {
  const aws = await startBedrockStandIn();
  const env = {
    INFINITARY_BEDROCK_TEST_URL: aws.url,
    AWS_BEARER_TOKEN_BEDROCK: "ambient-not-connected",
    INFINITARY_AWS_CLI: bedrockLoginExecutable(),
  };
  let launched = await launchApp({ prepareHome: installBedrockProfile, env }).catch(
    async (error: unknown) => {
      await aws.close();
      throw error;
    },
  );
  try {
    const { page } = launched;
    await pressKey(page.getByRole("button", { name: new RegExp(name) }), "Enter");
    await pressKey(
      page.getByRole("button", { name: BEDROCK_SIGN_IN.profile, exact: true }),
      "Enter",
    );
    const region = page.getByPlaceholder(BEDROCK_SIGN_IN.regionExample);
    await region.fill(BEDROCK_SIGN_IN.regionExample);
    await pressKey(region, "Enter");
    const profile = page.getByPlaceholder("default", { exact: true });
    await profile.fill(BEDROCK_PROFILE);
    await pressKey(profile, "Enter");
    const input = promptInput(page);
    await expect(input).toBeEnabled();
    expect(
      aws.calls.some((call) => call.model === BEDROCK_MODEL && call.check && call.signed),
    ).toBe(true);
    const requestsBeforeRenewal = aws.calls.filter((call) => !call.check).length;
    aws.requireProfileRotation(launched.homeDir);
    await input.fill("Answer after the AWS sign-in renews.");
    await pressKey(input, "Enter");
    const reply = bubbleWords(mateBubble(page));
    await expect(reply).toHaveText(BEDROCK_REPLY);
    await expect(reply).toBeVisible();
    const pair = aws.calls
      .filter((call) => !call.check)
      .slice(requestsBeforeRenewal, requestsBeforeRenewal + 2);
    expect(pair.map((call) => ({ profileId: call.profileId, signed: call.signed }))).toEqual([
      { profileId: PROFILE_KEY_ID, signed: true },
      { profileId: ROTATED_PROFILE_KEY_ID, signed: true },
    ]);
    const renewed = await page.evaluate(() => window.infinitary.accounts.list());
    expect(renewed.find((row) => row.providerId === BEDROCK_PROVIDER_ID)?.cutOff).toBeUndefined();
    removeBedrockProfile(launched.homeDir);
    await input.fill("Try this AWS profile now.");
    await pressKey(input, "Enter");
    await expect
      .poll(() =>
        page.evaluate(async (provider) => {
          const snapshot = await window.infinitary.quota.refresh();
          return snapshot?.providers.find((row) => row.provider === provider)?.reason;
        }, BEDROCK_PROVIDER_ID),
      )
      .toBe(BEDROCK_PROFILE_UNAVAILABLE);
    const rows = await page.evaluate(() => window.infinitary.accounts.list());
    expect(rows.find((row) => row.providerId === BEDROCK_PROVIDER_ID)?.cutOff).toBeUndefined();
    const regionModels = () =>
      page.evaluate(
        async (provider) =>
          (await window.infinitary.models.available())
            .filter((model) => model.provider === provider)
            .map((model) => model.id),
        BEDROCK_PROVIDER_ID,
      );
    const accountId = rows.find((row) => row.providerId === BEDROCK_PROVIDER_ID)?.id;
    if (!accountId) throw new Error("The connected profile has no account row.");
    await pressKey(page.getByRole("button", { name: "Settings", exact: true }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Intelligence", exact: true }), "Enter");
    const signIn = page
      .locator(`[data-account-row="${accountId}"]`)
      .getByRole("button", { name: "Sign in", exact: true });
    aws.afterExplicitRecovery(RECOVERED_BEDROCK_MODEL);
    await pressKey(signIn, "Enter");
    await expect.poll(regionModels).toEqual([RECOVERED_BEDROCK_MODEL]);
    const { userDataDir, homeDir } = launched;
    const checks = aws.calls.filter((call) => call.check).length;
    await launched.close();
    launched = await launchApp({ userDataDir, homeDir, env });
    // The successful recovery kept the new list on disk.
    await expect
      .poll(() =>
        launched.page.evaluate(
          async (provider) =>
            (await window.infinitary.models.available())
              .filter((model) => model.provider === provider)
              .map((model) => model.id),
          BEDROCK_PROVIDER_ID,
        ),
      )
      .toEqual([RECOVERED_BEDROCK_MODEL]);
    expect(aws.calls.filter((call) => call.check)).toHaveLength(checks);
  } finally {
    await launched.close();
    await aws.close();
  }
});

test("shared AWS recovery restores successful regions and keeps a denied region withheld after restart (INF-4973)", async () => {
  const aws = await startBedrockStandIn();
  const userDataDir = scratchDir("bedrock-shared-recovery-");
  const homeDir = scratchDir("bedrock-shared-home-");
  seedSharedBedrockRows(userDataDir);
  const env = {
    INFINITARY_BEDROCK_TEST_URL: aws.url,
    INFINITARY_AWS_CLI: bedrockLoginExecutable(),
  };
  let launched = await launchApp({
    userDataDir,
    homeDir,
    prepareHome: installBedrockProfile,
    env,
  }).catch(async (error: unknown) => {
    await aws.close();
    throw error;
  });
  try {
    const [primary, restored, denied] = SHARED_BEDROCK_ROWS;
    const outcomes = async () =>
      launched.page.evaluate(
        async ({ provider, restoredId, deniedId }) => {
          const accounts = await window.infinitary.accounts.list();
          const models = (await window.infinitary.models.available())
            .filter((model) => model.provider === provider)
            .map((model) => model.id)
            .sort();
          return {
            models,
            restored: accounts.find((row) => row.id === restoredId)?.cutOff?.class ?? null,
            denied: accounts.find((row) => row.id === deniedId)?.cutOff?.class ?? null,
          };
        },
        { provider: BEDROCK_PROVIDER_ID, restoredId: restored.id, deniedId: denied.id },
      );
    const { page } = launched;
    await pressKey(page.getByRole("button", { name: "Settings", exact: true }), "Enter");
    await pressKey(page.getByRole("tab", { name: "Intelligence", exact: true }), "Enter");
    expect(await outcomes()).toEqual({
      models: [DENIED_BEDROCK_MODEL],
      restored: "signed_out",
      denied: null,
    });
    aws.afterSharedRecovery();
    const release = aws.pauseRechecks();
    // Await the same operation the row's Sign in button calls, including all sibling checks.
    const signIn = page.evaluate((id) => window.infinitary.accounts.signIn(id), primary.id);
    void signIn.catch(() => undefined);
    try {
      await expect.poll(() => aws.calls.some((call) => call.check && call.signed)).toBe(true);
      await expect.poll(async () => (await outcomes()).models).not.toContain(DENIED_BEDROCK_MODEL);
    } finally {
      release();
      await signIn;
    }
    await expect
      .poll(
        () =>
          new Set(aws.calls.filter((call) => call.check && call.signed).map((call) => call.region)),
      )
      .toEqual(new Set(SHARED_BEDROCK_ROWS.map((row) => row.region)));
    const expected = {
      models: [BEDROCK_MODEL, RECOVERED_BEDROCK_MODEL].sort(),
      restored: null,
      denied: null,
    };
    await expect.poll(outcomes).toEqual(expected);
    await launched.close();
    launched = await launchApp({ userDataDir, homeDir, env });
    await expect.poll(outcomes).toEqual(expected);
  } finally {
    await launched.close();
    await aws.close();
  }
});
