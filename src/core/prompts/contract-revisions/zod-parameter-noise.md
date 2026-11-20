# A zod-owned parameter serves its shape, not its generator's lines

INF-718, filed from INF-643: main's crewmate fixed context crossed its derived boundary once the Careful validation schema and two tool wordings merged side by side.
Every tool parameter whose shape a zod schema owns is now written by one helper, `zodParameter` (`src/core/session/tools.ts`), which drops the JSON Schema dialect line and the safe-integer range zod writes beside each integer.
Neither says anything a model acts on, and no rule leaves any text.
The first mate's `emit_card` `required_actions` loses its dialect line, so its fixed context shrinks by 14 tokens, to 19,644 (`tests/firstmate-fixed-context.test.ts`).
The crewmate's `emit_card` also stops saying "Required on a completion merge offer, including [] when none." twice on `required_actions` and serves the first mate's parameter as it is; with the helper on `report`, `prepare_change` and `open_change`, its fixed context shrinks by 107 tokens, to 26,615 on Claude and 26,560 on Pi, under the unchanged 26,624 boundary (`tests/crewmate-fixed-context.test.ts`).
