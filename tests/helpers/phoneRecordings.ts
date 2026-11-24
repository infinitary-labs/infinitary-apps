/**
 * The test home's recording starts, by the command a journey sends, each naming the recording
 * scripts/test-phone.ts knows: a journey starts one just before the motion it keeps.
 */
export const CARD_RECORDINGS: Readonly<Record<string, string>> = {
  "capture-reply-start": "card-reply",
  "capture-media-start": "card-recording",
  "capture-picture-start": "card-picture",
  "capture-page-start": "card-paging",
  "capture-card-start": "card-form",
  "capture-conversation-start": "conversation",
  "capture-character-start": "character",
};
