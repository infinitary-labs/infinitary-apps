# Saved resets on an allowance reading

An allowance reading's row may carry the new optional field `savedResets`: how many saved resets the provider says the account holds (`available`), and how many would apply now (`applicable`), today read only from ChatGPT's usage reading for Codex (docs/quota.md, "Saved resets").
A row without it says nothing about saved resets, which is unknown, never none.
A side without this change ignores the field, so its Subscriptions row and run-out cards say nothing about saved resets, and a computer that runs work without it sends rows with no count.
The run-out cards say a saved reset in the card's body, with a link to the provider's usage page, so they add no button, host operation or request, and an older view shows that sentence in English.
