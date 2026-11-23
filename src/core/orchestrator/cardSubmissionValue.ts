import { randomUUID } from "node:crypto";
import {
  CARD_ANSWERS_BOUND_REFUSAL,
  CARD_ANSWERS_MAX_BYTES,
  type CardAnswer,
  type ChoiceCarriedRecord,
  cardAnswersBytes,
  type TurnImage,
} from "@shared/cards";
import { type ChoiceCarried, cardChromeValueSchema } from "@shared/choiceCarried";
import { keepImages } from "../attachments";
import { withPastedFiles } from "../overflow";

/**
 * The answers a footer click carries (inline decisions, contract 4.22), read
 * off its value: undefined for a click that carries none, which is every
 * card without a form and every caller from before the form. A value that
 * names answers and does not parse, or weighs more than the value bound,
 * refuses the click rather than dropping the captain's picks unsaid.
 */
export function chromeValue(value: unknown): { answers?: CardAnswer[]; carried?: ChoiceCarried } {
  if (typeof value !== "object" || value === null || !("answers" in value)) return {};
  const parsed = cardChromeValueSchema.safeParse(value);
  if (!parsed.success) throw new Error("The card's answers could not be read.");
  const { answers, notes, files, images } = parsed.data;
  if (cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
    throw new Error(CARD_ANSWERS_BOUND_REFUSAL);
  }
  // What else the card's field sent with the choice (`choice-attachments.md`).
  const carried: ChoiceCarried = {
    ...(notes?.length ? { notes } : {}),
    ...(files?.length ? { files } : {}),
    ...(images?.length ? { images } : {}),
  };
  return {
    ...(answers.length > 0 ? { answers } : {}),
    ...(Object.keys(carried).length > 0 ? { carried } : {}),
  };
}

/** What a note's own press carried: the field's words, and what else waited in it. */
export type NotePress = { words: string; carried?: ChoiceCarried };

/**
 * What a choice carried, as every reader gets it: the record keeps the notes,
 * the files as `withPastedFiles` gives them to a reader and the message's own
 * copies of the pictures; `images` are the pictures themselves for a live turn.
 */
export type KeptCarried = { record: ChoiceCarriedRecord; images?: ChoiceCarried["images"] };

export function keepCarried(carried: ChoiceCarried): KeptCarried {
  const files = carried.files?.length ? withPastedFiles("", carried.files) : "";
  const pictures = carried.images?.length ? keepImages(randomUUID(), carried.images) : undefined;
  return {
    record: {
      ...(carried.notes?.length ? { notes: carried.notes } : {}),
      ...(files ? { files } : {}),
      ...(pictures?.length ? { pictures } : {}),
    },
    ...(carried.images?.length ? { images: carried.images } : {}),
  };
}

/** The pictures a crewmate's steer carries live, and the lane row's copies of them. */
export function keptPictures(kept: KeptCarried | undefined): {
  images?: TurnImage[];
  attachments?: ChoiceCarriedRecord["pictures"];
} {
  return kept?.images?.length && kept.record.pictures?.length
    ? { images: kept.images, attachments: kept.record.pictures }
    : {};
}
