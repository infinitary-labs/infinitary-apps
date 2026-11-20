import { fromIni } from "@aws-sdk/credential-provider-ini";
import {
  type ApiKeyCredential,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  normalizeContext,
  type Provider,
} from "@earendil-works/pi-ai";
import { BEDROCK_PROVIDER_ID, BEDROCK_SIGN_IN } from "@shared/providers";
import { AWS_PROFILE_NAME, bedrockProfileFailure } from "./bedrockProfile";

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

const CLAUDE = /^(?:(global|us|eu|apac|au|jp|in|ca)\.)?anthropic\.claude-/;

export function bedrockCode(message: Pick<AssistantMessage, "diagnostics">): string | undefined {
  for (const diagnostic of message.diagnostics ?? []) {
    const code = diagnostic.details?.errorCode;
    if (diagnostic.type === "bedrock_response_failure" && typeof code === "string") return code;
  }
}

export function bedrockExpired(code: string | undefined): boolean {
  return (
    code === "ExpiredTokenException" ||
    code === "UnrecognizedClientException" ||
    code === "BedrockProfileRenewalRejectedException"
  );
}

/** Only re-resolve a named profile after a rejection before any output, never replay a stream. */
function refreshOnce(open: () => AssistantMessageEventStream, signal?: AbortSignal) {
  const result = createAssistantMessageEventStream();
  void (async () => {
    let renewalRefusal: Extract<Parameters<typeof result.push>[0], { type: "error" }> | undefined;
    for (const attempt of [0, 1]) {
      let started = false;
      for await (const event of open()) {
        if (event.type !== "error") started = true;
        if (
          event.type === "error" &&
          !started &&
          attempt === 0 &&
          !signal?.aborted &&
          bedrockExpired(bedrockCode(event.error))
        ) {
          if (bedrockCode(event.error) === "BedrockProfileRenewalRejectedException")
            renewalRefusal = event;
          break;
        }
        result.push(
          event.type === "error" &&
            !started &&
            renewalRefusal &&
            bedrockCode(event.error) === "BedrockProfileUnavailableException"
            ? renewalRefusal
            : event,
        );
        if (event.type === "error" || event.type === "done") return;
      }
    }
    result.end();
  })();
  return result;
}

export function bedrockModelInRegion(id: string, region: string): boolean {
  const match = CLAUDE.exec(id);
  if (!match) return false;
  const prefix = match[1];
  if (!prefix) return true;
  if (region.startsWith("us-gov-") || region.startsWith("cn-")) return false;
  if (prefix === "global") return true;
  if (prefix === "apac") return region.startsWith("ap-");
  if (prefix === "au") return region.startsWith("ap-southeast-");
  if (prefix === "in") return region === "ap-south-1" || region === "ap-south-2";
  if (prefix === "jp") return region === "ap-northeast-1" || region === "ap-northeast-3";
  return region.startsWith(`${prefix}-`);
}

function endpoint(region: string, test?: string): string {
  // The only override is the offline journey's local AWS stand-in.
  if (test && /^http:\/\/127\.0\.0\.1:\d+$/.test(test)) return test;
  return `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

function stored(credential: ApiKeyCredential | undefined) {
  const region = credential?.env?.AWS_REGION;
  const profile = credential?.env?.AWS_PROFILE;
  const checked = credential?.env?.INFINITARY_BEDROCK_MODELS;
  if (!region || !REGION.test(region) || !checked || !(profile || credential?.key)) return;
  return { region, profile, checked: new Set(checked.split("\n")) };
}

/** Pi keeps the account sign-in. Only AWS's SDK reads a named profile's keys. */
export function bedrockAccountProvider(
  stock: Provider,
  test?: string,
  profileUnavailable?: (unavailable: boolean) => void,
): Provider {
  const getModels = () => stock.getModels().filter((model) => CLAUDE.test(model.id));
  const request = <
    T extends Model<string>,
    O extends { env?: Record<string, string>; signal?: AbortSignal },
  >(
    model: T,
    options?: O,
  ) => {
    const region = options?.env?.AWS_REGION;
    if (!region || !REGION.test(region))
      throw new Error("Connect your Amazon Bedrock account first.");
    const profile = options?.env?.AWS_PROFILE;
    const baseUrl = endpoint(region, test);
    const scoped = {
      ...options,
      region,
      env: {
        AWS_BEDROCK_SCOPED_AUTH: "1",
        AWS_REGION: region,
        ...(baseUrl.startsWith("http:") ? { AWS_BEDROCK_FORCE_HTTP1: "1" } : {}),
      },
      ...(profile
        ? {
            credentials: async () => {
              try {
                const identity = await fromIni({ profile, ignoreCache: true })();
                if (!options?.signal?.aborted) profileUnavailable?.(false);
                return identity;
              } catch (cause) {
                const failure = bedrockProfileFailure(cause);
                if (!options?.signal?.aborted)
                  profileUnavailable?.(failure.name === "BedrockProfileUnavailableException");
                throw failure;
              }
            },
          }
        : {}),
    };
    return { model: { ...model, baseUrl }, options: scoped };
  };
  const provider: Provider = {
    id: BEDROCK_PROVIDER_ID,
    name: stock.name,
    getModels,
    filterModels: (models, credential) => {
      if (credential?.type !== "api_key") return [];
      const info = stored(credential);
      return info
        ? models.filter(
            (model) => info.checked.has(model.id) && bedrockModelInRegion(model.id, info.region),
          )
        : [];
    },
    stream(model, context, options) {
      const open = () => {
        const scoped = request(model, options);
        return stock.stream(scoped.model, context, scoped.options as typeof options);
      };
      return options?.env?.AWS_PROFILE ? refreshOnce(open, options.signal) : open();
    },
    streamSimple(model, context, options) {
      const open = () => {
        const scoped = request(model, options);
        return stock.streamSimple(scoped.model, context, scoped.options);
      };
      return options?.env?.AWS_PROFILE ? refreshOnce(open, options.signal) : open();
    },
    auth: {
      apiKey: {
        name: "Your AWS sign-in",
        async login(interaction) {
          const method = await interaction.prompt({
            type: "select",
            message: "How do you want to connect to Amazon Bedrock?",
            options: [
              { id: "profile", label: BEDROCK_SIGN_IN.profile },
              { id: "key", label: BEDROCK_SIGN_IN.key },
            ],
          });
          if (method !== "profile" && method !== "key") throw new Error("Choose a way to sign in.");
          const region = (
            await interaction.prompt({
              type: "text",
              message: "Which AWS region should this account use?",
              placeholder: BEDROCK_SIGN_IN.regionExample,
            })
          )
            .trim()
            .toLowerCase();
          if (!REGION.test(region)) throw new Error("Enter an AWS region such as us-west-2.");
          const profile =
            method === "profile"
              ? (
                  await interaction.prompt({
                    type: "text",
                    message: "Enter your AWS profile name.",
                    placeholder: "default",
                  })
                ).trim()
              : undefined;
          if (profile !== undefined && !AWS_PROFILE_NAME.test(profile))
            throw new Error("Enter the name of an AWS profile on this computer.");
          const key =
            method === "key"
              ? (
                  await interaction.prompt({
                    type: "secret",
                    message: "Paste a long-term Bedrock API key. It stays on this computer.",
                    placeholder: BEDROCK_SIGN_IN.key,
                  })
                ).trim()
              : undefined;
          if (key !== undefined && (!key || /\s/.test(key)))
            throw new Error("Enter a Bedrock API key.");
          interaction.notify({
            type: "progress",
            message:
              "Checking which Claude models your AWS sign-in can use. AWS may bill these small checks.",
          });
          const env = { AWS_REGION: region, ...(profile ? { AWS_PROFILE: profile } : {}) };
          const models = getModels().filter(({ id }) => bedrockModelInRegion(id, region));
          const checked: string[] = [];
          for (const model of models) {
            interaction.signal.throwIfAborted();
            const result = await provider
              .streamSimple(
                model,
                normalizeContext({
                  messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
                }),
                { apiKey: key, env, maxTokens: 1, signal: interaction.signal },
              )
              .result();
            interaction.signal.throwIfAborted();
            if (result.stopReason !== "error" && result.stopReason !== "aborted")
              checked.push(model.id);
            else if (bedrockCode(result) === "ThrottlingException")
              throw new Error("Amazon Bedrock is busy. Try again in a moment.");
            else if (bedrockCode(result) === "BedrockProfileUnavailableException")
              throw new Error(
                "Could not use your AWS sign-in. Check your AWS profile and try again.",
              );
            else if (bedrockExpired(bedrockCode(result)))
              throw new Error("Check your AWS sign-in and try again.");
          }
          if (!checked.length)
            throw new Error(
              "No Claude models answered in that AWS region. Check your AWS sign-in and model access.",
            );
          return {
            type: "api_key",
            ...(key ? { key } : {}),
            env: { ...env, INFINITARY_BEDROCK_MODELS: checked.join("\n") },
          };
        },
        async check({ credential }) {
          return stored(credential) ? { type: "api_key", source: "stored credential" } : undefined;
        },
        async resolve({ credential }) {
          const info = stored(credential);
          if (!info) return;
          return {
            auth: credential?.key ? { apiKey: credential.key } : {},
            env: {
              AWS_REGION: info.region,
              ...(info.profile ? { AWS_PROFILE: info.profile } : {}),
            },
            source: "stored credential",
          };
        },
      },
    },
  };
  return provider;
}
