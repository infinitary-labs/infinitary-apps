import { fromIni } from "@aws-sdk/credential-provider-ini";
import {
  type ApiKeyCredential,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthPrompt,
  createAssistantMessageEventStream,
  type Model,
  normalizeContext,
  type Provider,
} from "@earendil-works/pi-ai";
import * as m from "@shared/i18n/messages.generated";
import { BEDROCK_PROVIDER_ID, BEDROCK_SIGN_IN } from "@shared/providers";
import type { BedrockClaudeSetup } from "../claude/claudeAccess";
import {
  type BedrockAddress,
  type BedrockResolver,
  bedrockConnection,
  bedrockConnectionFailure,
  holdBedrockAddress,
  lookupAll,
  readBedrockAddress,
} from "./bedrockConnection";
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

/** Saved beside the region: the approved organization address and its network kind. */
export const BEDROCK_ADDRESS_ENV = "INFINITARY_BEDROCK_ADDRESS";
export const BEDROCK_NETWORK_ENV = "INFINITARY_BEDROCK_NETWORK";

export type BedrockAccountOptions = {
  /** The offline journey's local stand-in for AWS's own address. */
  test?: string;
  profileUnavailable?: (unavailable: boolean) => void;
  /** How an organization address's name is looked up; tests stand in for DNS. */
  resolve?: BedrockResolver;
  claudeSetup?: () => Promise<BedrockClaudeSetup | undefined>;
};

/** An address and kind saved together, or both absent; anything else is no address at all. */
function savedAddress(
  env: Record<string, string> | undefined,
): { address?: BedrockAddress } | undefined {
  const raw = env?.[BEDROCK_ADDRESS_ENV];
  const network = env?.[BEDROCK_NETWORK_ENV];
  if (!raw && !network) return {};
  const address = raw && network ? holdBedrockAddress(raw, network) : undefined;
  return address ? { address } : undefined;
}

/** The host an account's requests are sent through, when it saved an organization address. */
export function bedrockSentThrough(env: Record<string, string> | undefined): string | undefined {
  const address = savedAddress(env)?.address;
  return address ? new URL(address.baseUrl).host : undefined;
}

function stored(credential: ApiKeyCredential | undefined) {
  const region = credential?.env?.AWS_REGION;
  const profile = credential?.env?.AWS_PROFILE;
  const checked = credential?.env?.INFINITARY_BEDROCK_MODELS;
  const saved = savedAddress(credential?.env);
  if (!region || !REGION.test(region) || !checked || !saved) return;
  // No key and no profile only where an organization address signs requests itself.
  if (!(profile || credential?.key || saved.address)) return;
  return { region, profile, address: saved.address, checked: new Set(checked.split("\n")) };
}

/** Pi's text prompt with the starting value the app's prompt view shows (`AuthPromptView.value`). */
function textPrompt(message: string, placeholder: string, value?: string): AuthPrompt {
  return { type: "text", message, placeholder, ...(value ? { value } : {}) } as AuthPrompt;
}

function approval(address: BedrockAddress): string {
  const host = new URL(address.baseUrl).host;
  if (address.mode === "local") return m.bedrockSignInApproveLocal({ host });
  if (address.mode === "private") return m.bedrockSignInApprovePrivate({ host });
  return m.bedrockSignInApprovePublic({ host });
}

/** Pi keeps the account sign-in. Only AWS's SDK reads a named profile's keys. */
export function bedrockAccountProvider(
  stock: Provider,
  { test, profileUnavailable, resolve = lookupAll, claudeSetup }: BedrockAccountOptions = {},
): Provider {
  const getModels = () => stock.getModels().filter((model) => CLAUDE.test(model.id));
  const request = <
    T extends Model<string>,
    O extends { env?: Record<string, string>; signal?: AbortSignal; apiKey?: string },
  >(
    model: T,
    options?: O,
  ) => {
    const region = options?.env?.AWS_REGION;
    const saved = savedAddress(options?.env);
    if (!region || !REGION.test(region) || !saved)
      throw new Error("Connect your Amazon Bedrock account first.");
    const profile = options?.env?.AWS_PROFILE;
    // Without a key or profile, only an organization address may be asked, and then with no credentials.
    const noAuth = !profile && !options?.apiKey;
    if (noAuth && !saved.address) throw new Error("Connect your Amazon Bedrock account first.");
    const baseUrl = saved.address?.baseUrl ?? endpoint(region, test);
    const scoped = {
      ...options,
      region,
      env: { AWS_BEDROCK_SCOPED_AUTH: "1", AWS_REGION: region },
      ...bedrockConnection(baseUrl, saved.address, resolve),
      ...(noAuth ? { noAuth: true } : {}),
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
          // Claude Code's Bedrock settings only start the prompts; every step still asks.
          const setup = await claudeSetup?.().catch(() => undefined);
          const fromSettings =
            setup?.source === "organization"
              ? m.bedrockSignInFromOrganization()
              : setup
                ? m.bedrockSignInFromClaudeSettings()
                : undefined;
          const filled = (message: string, value: string | undefined) =>
            value && fromSettings ? `${message} ${fromSettings}` : message;
          const connectQuestion = "How do you want to connect to Amazon Bedrock?";
          const method = await interaction.prompt({
            type: "select",
            message:
              setup?.skipAuth && setup.address
                ? `${connectQuestion} ${m.bedrockSignInSettingsNoKey()}`
                : connectQuestion,
            options: [
              { id: "profile", label: BEDROCK_SIGN_IN.profile },
              { id: "key", label: BEDROCK_SIGN_IN.key },
              { id: "none", label: m.bedrockSignInNoKey() },
            ],
          });
          if (method !== "profile" && method !== "key" && method !== "none")
            throw new Error("Choose a way to sign in.");
          const region = (
            await interaction.prompt(
              textPrompt(
                filled("Which AWS region should this account use?", setup?.region),
                BEDROCK_SIGN_IN.regionExample,
                setup?.region,
              ),
            )
          )
            .trim()
            .toLowerCase();
          if (!REGION.test(region)) throw new Error("Enter an AWS region such as us-west-2.");
          // A sign-in without a key has nowhere to go but an organization address.
          const where =
            method === "none"
              ? "organization"
              : await interaction.prompt({
                  type: "select",
                  message: filled(m.bedrockSignInWhere(), setup?.address),
                  options: [
                    { id: "aws", label: m.bedrockSignInStraightToAws() },
                    { id: "organization", label: m.bedrockSignInOrganization() },
                  ],
                });
          if (where !== "aws" && where !== "organization")
            throw new Error(m.bedrockSignInChooseWhere());
          let address: BedrockAddress | undefined;
          if (where === "organization") {
            const typed = await interaction.prompt(
              textPrompt(
                filled(m.bedrockSignInAddress(), setup?.address),
                "https://bedrock.example.com",
                setup?.address,
              ),
            );
            address = await readBedrockAddress(typed.trim(), resolve);
            // The option names the kind it approves, so a re-sign-in only approves the kind saved before.
            const approved = await interaction.prompt({
              type: "select",
              message: approval(address),
              options: [{ id: `send:${address.mode}`, label: m.bedrockSignInSend() }],
            });
            if (approved !== `send:${address.mode}`)
              throw new Error(m.bedrockAddressMoved({ host: new URL(address.baseUrl).host }));
          }
          const profile =
            method === "profile"
              ? (
                  await interaction.prompt(
                    textPrompt(
                      filled("Enter your AWS profile name.", setup?.profile),
                      "default",
                      setup?.profile,
                    ),
                  )
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
          const env = {
            AWS_REGION: region,
            ...(profile ? { AWS_PROFILE: profile } : {}),
            ...(address
              ? { [BEDROCK_ADDRESS_ENV]: address.baseUrl, [BEDROCK_NETWORK_ENV]: address.mode }
              : {}),
          };
          const host = new URL(address?.baseUrl ?? endpoint(region, test)).host;
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
            const unanswered =
              result.stopReason === "error" ? bedrockConnectionFailure(result) : undefined;
            if (result.stopReason !== "error" && result.stopReason !== "aborted")
              checked.push(model.id);
            else if (unanswered === "secure-connection")
              throw new Error(m.bedrockSecureConnectionFailed({ host }));
            else if (unanswered === "destination") throw new Error(m.bedrockAddressMoved({ host }));
            else if (unanswered === "unreachable") throw new Error(m.bedrockUnreachable({ host }));
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
              ...(info.address
                ? {
                    [BEDROCK_ADDRESS_ENV]: info.address.baseUrl,
                    [BEDROCK_NETWORK_ENV]: info.address.mode,
                  }
                : {}),
            },
            source: "stored credential",
          };
        },
      },
    },
  };
  return provider;
}
