# Personal extension fixtures

One extension per data skill (`resources/personal-workspace/skills/`), written
exactly as that skill teaches: `manifest.json`, `panel.tsx` importing
`@firstmate/ui`, and `server.ts` where the data needs the core.

They are real, typechecked, lint-clean extensions, and they are what proves a
skill teaches something that actually compiles and renders:

- `personalFixtures.test.ts` parses every manifest and runs the real
  `pluginLint` over every file - zero findings, no exceptions;
- `tests/e2e/ui-kit-panel.spec.ts` mounts all four on a rail and screenshots
  them in both themes.

In the repo `@firstmate/ui` and `@firstmate/contracts` resolve through the
build's aliases; in the Personal workspace the compiler and the generated
`infinitary-env.d.ts` resolve the same two specifiers to the same places.
