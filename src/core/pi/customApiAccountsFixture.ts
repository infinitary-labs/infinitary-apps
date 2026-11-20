import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { CustomApiInput } from "@shared/customApi";
import { afterEach, beforeEach, vi } from "vitest";
import {
  chatFrame,
  customChatCall,
  customChatText,
  customResponsesCall,
  customResponsesText,
  sendCustomStream,
} from "../../../tests/helpers/customApiDialect";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { appPathsFor } from "../paths";
import { AccountVault } from "./accountVault";
import { catalogRefreshesSettled } from "./modelRuntime";

const servers: Server[] = [];
export const vaults: AccountVault[] = [];
beforeEach(() => {
  const home = scratchDir("custom-accounts-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(home, "signing"));
  vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(async () => {
  for (const vault of vaults.splice(0))
    for (const account of vault.list())
      if (account.providerId.startsWith("fm-custom-")) await vault.remove(account.id);
  await catalogRefreshesSettled();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});
export async function fixture() {
  const requests: {
    path?: string;
    authorization?: string;
    extra: Record<string, string | undefined>;
    body: Record<string, unknown>;
  }[] = [];
  let status = 200;
  let tools = false;
  let pictures = false;
  let workCallSent = false;
  let reads = 0;
  let reportHigh = false;
  let windowTokens: number | undefined;
  let cutBelow = 0;
  let tokenBytes = 4;
  let reportEnforced = true;
  const refused: number[] = [];
  const refusedText: string[] = [];
  const answered: string[] = [];
  const latestUser = (value: Record<string, unknown>) => {
    const messages = value.messages;
    if (!Array.isArray(messages)) return "";
    const user = [...messages]
      .reverse()
      .find((message) => message && typeof message === "object" && message.role === "user");
    return JSON.stringify(user ?? "");
  };
  let countTokens = false;
  let lengthWithoutUsage = false;
  let answer: string | string[] = "Synthetic work answer.";
  let hold: "check" | "work" | undefined;
  let reached: (() => void) | undefined;
  let releaseHeld: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({
      path: req.url,
      authorization: req.headers.authorization,
      extra: {
        org: req.headers["x-org-id"] as string | undefined,
        token: req.headers["x-gateway-token"] as string | undefined,
      },
      body,
    });
    if (status !== 200) {
      res.writeHead(status);
      res.end("opaque-synthetic-secret");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "listed-model", context_length: 131072, max_completion_tokens: 8192 },
            { id: "unlisted-limits" },
          ],
        }),
      );
      return;
    }
    const responses = req.url?.endsWith("/responses");
    const transcript = JSON.stringify(body);
    const isCheck = transcript.includes("synthetic API connection check");
    if (isCheck && transcript.includes("data:image/png;base64,")) {
      sendCustomStream(
        res,
        (responses ? customResponsesText : customChatText)(pictures ? "47" : "unknown"),
      );
      return;
    }
    if ((hold === "check" && isCheck) || (hold === "work" && !isCheck)) {
      hold = undefined;
      await new Promise<void>((resolve) => {
        releaseHeld = resolve;
        reached?.();
      });
    }
    const hasResult =
      transcript.includes('"role":"tool"') || transcript.includes('"type":"function_call_output"');
    if (
      !isCheck &&
      tools &&
      !workCallSent &&
      !hasResult &&
      transcript.includes("Synthetic tool work")
    ) {
      workCallSent = true;
      sendCustomStream(
        res,
        (responses ? customResponsesCall : customChatCall)(
          "session_echo",
          '{"text":"session-value"}',
          "work_call",
        ),
      );
      return;
    }
    // A turn that reads files asks for one more while any are left; a
    // compaction's summary request carries no tools and is answered.
    if (!isCheck && reads > 0 && Array.isArray(body.tools)) {
      sendCustomStream(
        res,
        (responses ? customResponsesCall : customChatCall)(
          "read_file",
          `{"path":"file-${reads}.ts"}`,
          `read_${reads--}`,
        ),
      );
      return;
    }
    let usage = !isCheck && reportHigh ? { input: 60000, output: 20 } : undefined;
    if (!isCheck && windowTokens) {
      const count = Math.ceil(
        Buffer.byteLength(JSON.stringify(body.messages ?? body.input ?? [])) / tokenBytes,
      );
      const max = Number(
        body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? 0,
      );
      if (count + max > windowTokens) {
        refused.push(count + max);
        refusedText.push(latestUser(body));
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `This model's maximum context length is ${windowTokens} tokens. However, you requested ${count + max} tokens (${count} in the messages, ${max} in the completion). Please reduce the length of the messages or completion.`,
              type: "BadRequestError",
            },
          }),
        );
        return;
      }
      if (max < cutBelow) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          chatFrame({ content: "Cut" }) +
            chatFrame({}, "length") +
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: count, completion_tokens: max } })}\n\n` +
            "data: [DONE]\n\n",
        );
        return;
      }
      if (reportEnforced) usage = { input: count, output: 300 };
    } else if (!isCheck && lengthWithoutUsage) {
      lengthWithoutUsage = false;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        chatFrame({ content: "Finished the file." }) + chatFrame({}, "length") + "data: [DONE]\n\n",
      );
      return;
    } else if (!isCheck && countTokens) {
      usage = {
        input: Math.ceil(Buffer.byteLength(JSON.stringify(body.messages ?? body.input ?? [])) / 4),
        output: 20,
      };
    }
    if (!isCheck) {
      reportHigh = false;
      answered.push(latestUser(body));
    }
    sendCustomStream(
      res,
      isCheck && !hasResult
        ? (responses ? customResponsesCall : customChatCall)(
            "firstmate_echo",
            '{"text":"FIRSTMATE_CUSTOM_API_OK"}',
          )
        : (responses ? customResponsesText : customChatText)(
            isCheck ? "FIRSTMATE_CUSTOM_API_OK" : answer,
            usage,
          ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    hold: (kind: "check" | "work") => {
      hold = kind;
      return new Promise<void>((resolve) => {
        reached = resolve;
      });
    },
    release: () => {
      releaseHeld?.();
      releaseHeld = undefined;
    },
    pictures: () => {
      pictures = true;
    },
    tools: () => {
      tools = true;
    },
    reads: (count: number) => {
      reads = count;
    },
    highUsage: () => {
      reportHigh = true;
    },
    enforce: (tokens: number, cut: number, bytesPerToken = 4, reportUsage = true) => {
      windowTokens = tokens;
      cutBelow = cut;
      tokenBytes = bytesPerToken;
      reportEnforced = reportUsage;
    },
    refused,
    refusedText,
    answered,
    count: () => {
      countTokens = true;
    },
    lengthWithoutUsage: () => {
      lengthWithoutUsage = true;
    },
    answer: (text: string | string[]) => {
      answer = text;
    },
    refuse: (code: number) => {
      status = code;
    },
  };
}
export function input(
  baseUrl: string,
  protocol: CustomApiInput["protocol"] = "openai-completions",
): CustomApiInput {
  return {
    label: "Synthetic connection",
    baseUrl,
    approvedDestination: baseUrl,
    mode: "local",
    protocol,
    key: "opaque-synthetic-secret",
    noKey: false,
    headers: [],
    unencryptedLocalApproved: true,
    allowStorageDefault: false,
    storageApproved: false,
    models: [{ id: "operator-model", context: 65536, output: 1024 }],
  };
}
export function vault() {
  const paths = appPathsFor(scratchDir("custom-account-store-"));
  const result = AccountVault.create(paths);
  vaults.push(result);
  return { vault: result, paths };
}
