# A Claude seat is served each tool's limits

INF-744, filed from INF-733: a Claude seat was served every app tool with its limits removed.
The SDK's `createSdkMcpServer` wrote each schema with the older zod it bundles, which reads a schema the app's zod built with a check as the bare type beneath it.
So a Claude first mate or crewmate read `check_change`'s `pull` as a plain number and `prepare_change`'s `story.base` with no pattern, and guessed until a call was refused.
The app now serves its tools from its own copy of the MCP server, whose list is each tool's own JSON Schema, the one a Pi seat is served; a call is still checked against the zod built from it.
No tool's name, description or parameters change, so the stamp's two hashes and both fixed contexts stay where they were.
What a Claude seat reads changes: the first mate's 24 tools now carry 58 limits (a minimum, a maximum, a pattern, an item count or a length) and a crewmate's 19 carry 258, where both carried none; `claudeToolSurface.test.ts` holds each served schema equal to the source.
A call the zod refuses now says why in a sentence, such as `Too small: expected number to be >=1 at pull`, where the SDK's server served zod's raw issue list.
The same server also serves nested descriptions, which the audit had read as the client dropping; no app tool declares one, and each rule keeps its home in a description or a top-level parameter.
