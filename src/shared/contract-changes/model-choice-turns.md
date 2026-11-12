A task's `modelChoice` optionally carries `turns`, set when models with no allowance reading took turns for the choice and the picked one was the one picked least recently.
Its `decidedBy` stays `runway-order` for such a choice.
An older side ignores the field and words the choice as the usual order deciding.
