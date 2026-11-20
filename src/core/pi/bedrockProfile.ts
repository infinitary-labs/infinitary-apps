import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { withoutAwsEnvironment } from "@shared/awsEnvironment";
import { parseKnownFiles } from "@smithy/core/config";
import { hostEnv } from "../hostEnv";

const run = promisify(execFile);
export const AWS_PROFILE_NAME = /^\w[\w.@+-]*$/;

export async function resolveBedrockProfile(profile: string): Promise<void> {
  if (!AWS_PROFILE_NAME.test(profile))
    throw new Error("Enter the name of an AWS profile on this computer.");
  await fromIni({ profile, ignoreCache: true })();
}

type BedrockProfiles = Awaited<ReturnType<typeof parseKnownFiles>>;

/** Follow assume-role profiles to the profile the AWS sign-in command must renew. */
export function bedrockSourceProfile(profiles: BedrockProfiles, profile: string): string {
  const seen = new Set<string>();
  let current = profile;
  while (!seen.has(current)) {
    seen.add(current);
    const row = Object.hasOwn(profiles, current) ? profiles[current] : undefined;
    if (!row?.role_arn || !row.source_profile || row.web_identity_token_file) return current;
    current = row.source_profile;
  }
  return profile;
}

/** Names constituting the same SDK sign-in cache; no cache token or expiry is read. */
export function bedrockProfileIdentity(profiles: BedrockProfiles, profile: string): string {
  const source = bedrockSourceProfile(profiles, profile);
  const row = Object.hasOwn(profiles, source) ? profiles[source] : undefined;
  if (row && !row.aws_access_key_id && !row.credential_process && !row.web_identity_token_file) {
    if (row.sso_session) return `sso-session:${row.sso_session}`;
    if (row.sso_start_url) return `sso-url:${row.sso_start_url}`;
    if (row.login_session) return `login-session:${row.login_session}`;
  }
  return `profile:${source}`;
}

/** The CLI reads the same files as Smithy, but cannot inherit an AWS sign-in. */
export function bedrockSignInEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = withoutAwsEnvironment(base);
  for (const name of [
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_LOGIN_CACHE_DIRECTORY",
  ]) {
    if (base[name] !== undefined) clean[name] = base[name];
  }
  return clean;
}

export function bedrockProfiles(): ReturnType<typeof parseKnownFiles> {
  return parseKnownFiles({ ignoreCache: true });
}

/** No inference from SDK prose or timestamps: a local access key can expire while the sign-in can still renew. */
export function bedrockProfileFailure(error: unknown): Error {
  const seen = new Set<Error>();
  for (let cause = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    const service = cause as Error & {
      $metadata?: { httpStatusCode?: number };
      error?: string;
      awsRenewalOperation?: string;
    };
    const status = service.$metadata?.httpStatusCode;
    if (status === undefined) continue;
    let code: string | undefined;
    if (
      (service.awsRenewalOperation === "CreateOAuth2Token" &&
        cause.name === "AccessDeniedException" &&
        (service.error === "TOKEN_EXPIRED" || service.error === "USER_CREDENTIALS_CHANGED")) ||
      (service.awsRenewalOperation === "CreateToken" && cause.name === "InvalidGrantException")
    )
      code = "BedrockProfileRenewalRejectedException";
    else if (["AccessDenied", "AccessDeniedException", "ForbiddenException"].includes(cause.name))
      code = "AccessDeniedException";
    else if (["Throttling", "ThrottlingException", "TooManyRequestsException"].includes(cause.name))
      code = "ThrottlingException";
    if (code)
      return Object.assign(new Error("AWS refused the profile request."), {
        name: code,
        bedrockStage: "credential_resolution",
      });
  }
  const unavailable = new Error("Could not use your AWS sign-in.");
  unavailable.name = "BedrockProfileUnavailableException";
  return Object.assign(unavailable, { bedrockStage: "credential_resolution" });
}

/** A URL is usable only after its own stream has supplied a delimiter. */
export function awsLoginUrl(output: string): string | undefined {
  for (const [url] of output.matchAll(/https:\/\/[a-z0-9.-]+(?::443)?\/[^\s<>"']+(?=[\s<>"'])/gi)) {
    const site = new URL(url);
    if (/\.(?:amazonaws\.com|awsapps\.com|aws\.amazon\.com|aws)$/.test(site.hostname)) return url;
  }
}

/** Opens nothing on its own. Called only by the sign-in action on the account. */
export async function signInBedrockProfile(
  profile: string,
  interaction: ProviderAuthInteraction,
  awsCli?: string,
): Promise<void> {
  const { signal } = interaction;
  if (!AWS_PROFILE_NAME.test(profile))
    throw new Error("Enter the name of an AWS profile on this computer.");
  if (awsCli !== undefined && !isAbsolute(awsCli))
    throw new Error("The AWS CLI stand-in needs an absolute path.");
  const executable = awsCli ?? "aws";
  const env = bedrockSignInEnv(hostEnv());
  try {
    await run(executable, ["--version"], { env, signal, windowsHide: true });
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Set up the AWS command line on this computer, then sign in again.");
    throw new Error("Could not start AWS sign-in on this computer.");
  }
  const sso = async (setting: string) => {
    try {
      const result = await run(executable, ["configure", "get", setting, "--profile", profile], {
        env,
        signal,
        windowsHide: true,
      });
      return Boolean(result.stdout.trim());
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  const identityCenter = (await sso("sso_session")) || (await sso("sso_start_url"));
  const consoleLogin = !identityCenter && (await sso("login_session"));
  if (!identityCenter && !consoleLogin)
    throw new Error("Renew your sign-in in your AWS profile on this computer, then try again.");
  const args = identityCenter
    ? ["sso", "login", "--no-browser", "--use-device-code"]
    : ["login", "--remote"];
  const child = spawn(executable, [...args, "--profile", profile], {
    env,
    signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const streams = { stdout: "", stderr: "" };
    let prompted = false;
    const scan = (stream: keyof typeof streams, data: Buffer) => {
      if (prompted) return;
      streams[stream] = `${streams[stream]}${data.toString()}`.slice(-8192);
      const url = awsLoginUrl(streams.stdout) ?? awsLoginUrl(streams.stderr);
      if (!url) return;
      if (identityCenter) {
        const code = [streams.stdout, streams.stderr]
          .map((text) => text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}(?=\s)/)?.[0])
          .find(Boolean);
        if (!code) return;
        prompted = true;
        interaction.notify({ type: "device_code", userCode: code, verificationUri: url });
      } else {
        prompted = true;
        interaction.notify({
          type: "auth_url",
          url,
          instructions: "Finish your AWS sign-in in your browser.",
        });
        void interaction
          .prompt({ type: "manual_code", message: "Paste the code AWS shows in your browser." })
          .then(
            (code) => {
              if (!/^[a-z0-9_-]+$/i.test(code.trim())) {
                child.kill();
                reject(new Error("That does not look like the code from AWS."));
              } else child.stdin.end(`${code.trim()}\n`);
            },
            (error: unknown) => {
              child.kill();
              reject(error);
            },
          );
      }
    };
    child.stdout.on("data", (data: Buffer) => scan("stdout", data));
    child.stderr.on("data", (data: Buffer) => scan("stderr", data));
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("Could not finish your AWS sign-in.")));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Could not finish your AWS sign-in.")),
    );
  });
  await resolveBedrockProfile(profile);
}
