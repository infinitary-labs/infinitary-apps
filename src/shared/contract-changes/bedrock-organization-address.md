# A sign-in prompt's starting value and a Bedrock account's address

A sign-in prompt (`authPromptSchema`, `src/shared/providers.ts`) adds an optional `value`: what a text prompt's field starts with, such as an Amazon Bedrock region read from the person's Claude Code settings.
A side from before ignores it, and its field starts empty as it did.
An account view (`accountViewSchema`, `src/shared/accounts.ts`) adds an optional `sentThrough`: the host an Amazon Bedrock account's requests go through, when its sign-in saved an organization address.
A view from before ignores it, and its Subscriptions row does not name the host.
