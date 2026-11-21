# A preview's settings follow the captain between windows

INF-5446, the captain's ask that the answers picked on a card show on the captain's other computers when the card is left unfinished.
The card's unsent picks, the words in its field and its queued notes are now kept on the first mate's computer and shown in every window, until a press or reply submits them.
For a playable preview the captain chose to apply a setting from another window through the preview's own controls: "can't we sync the settings in a way that behaves as if the user clicked on those setting values and would also trigger the interactive previews to update its state?"

A crewmate's card authoring text (`CARD_AUTHORING`) rewrites its one sentence on a preview's settings: `inf.stage(name, value, apply)` takes a third argument, `apply(value)`, that sets the preview's own controls to a snapshot, so another window's or a restored setting shows as if picked; and controls update the card's unsent draft, where the sentence said the renderer's draft.
That rule's one home stays that crew-only sentence.
The Firstmate's fixed context stays as it was: the sentence is crew-only, and the Firstmate reads a submitted preview setting as before.
