import { expect, it } from "vitest";
import { withoutAwsEnvironment } from "./awsEnvironment";

it("keeps inherited AWS sign-ins out of non-Bedrock launch environments (INF-3451)", () => {
  const env = {
    AWS_PROFILE: "example",
    aws_region: "us-west-2",
    AWS_BEARER_TOKEN_BEDROCK: "disposable-example",
    AWS_ENDPOINT_URL: "http://127.0.0.1:9",
    CLAUDE_CODE_USE_BEDROCK: "1",
    PATH: "/usr/bin",
    HOME: "/tmp/example",
  };
  expect(withoutAwsEnvironment(env)).toEqual({ PATH: env.PATH, HOME: env.HOME });
  expect(env.AWS_PROFILE).toBe("example");
});
