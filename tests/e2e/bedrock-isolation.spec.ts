import { expect, test } from "@playwright/test";
import { BEDROCK_PROVIDER_ID } from "../../src/shared/providers";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE } from "./mockProvider";
import { promptInput } from "./prompt";
import { startBedrockStandIn } from "./scenarios/bedrock";
import { showCard } from "./stack";
import { pressKey } from "./windowKeys";

test("ambient AWS settings cannot offer or call Bedrock without a connected account (INF-3451)", async () => {
  const aws = await startBedrockStandIn();
  try {
    const launched = await launchApp({
      withMockProvider: true,
      env: {
        INFINITARY_BEDROCK_TEST_URL: aws.url,
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: aws.url,
        AWS_BEARER_TOKEN_BEDROCK: "disposable-ambient-key",
        AWS_REGION: "us-west-2",
      },
    });
    try {
      const { page } = launched;
      const bedrockCounts = () =>
        page.evaluate(async (provider) => {
          const [accounts, models] = await Promise.all([
            window.infinitary.accounts.list(),
            window.infinitary.models.available(),
          ]);
          return {
            accounts: accounts.filter((row) => row.providerId === provider).length,
            offerings: models.filter((model) => model.provider === provider).length,
          };
        }, BEDROCK_PROVIDER_ID);
      await waitForFirstmateIdle(page);
      const before = await bedrockCounts();
      expect(before).toEqual({ accounts: 0, offerings: 0 });
      const input = promptInput(page);
      await input.fill(`What can you do here? ${ANSWER_PROMPT_MARKER}`);
      await pressKey(input, "Enter");
      await showCard(page, MOCK_ANSWER_TITLE);
      await waitForFirstmateIdle(page);
      const after = await bedrockCounts();
      expect(after).toEqual(before);
      expect(aws.calls).toHaveLength(0);
      await test.info().attach("bedrock-no-account", {
        contentType: "application/json",
        body: JSON.stringify({
          before,
          after,
          completedReply: MOCK_ANSWER_TITLE,
          bedrockRequests: aws.calls.length,
        }),
      });
    } finally {
      await launched.close();
    }
  } finally {
    await aws.close();
  }
});
