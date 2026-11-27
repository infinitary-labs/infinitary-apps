# Google's question answers with one button per choice

A card action's `request_write` effect may carry the optional `pick`: the place's own choice that button sends once, which only the host's card for Google's question declares (`requestWriteEffectSchema`, `src/shared/cardEffects.ts`).
A view from before reads the effect without the field and draws the button by its label as any other; its click names the action, and the home reads the pick from the card it holds.
