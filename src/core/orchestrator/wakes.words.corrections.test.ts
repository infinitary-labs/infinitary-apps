import {
  type CorrectionWakeKind,
  pinWakeWords,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";

/** Intent: the standing byte-exact wake contract and the approved case-only
 * correction guidance. Disposable source references exercise real rendering;
 * these cases do not assert classifier recognition. */
const source = { key: "ask:source-one", kind: "composer" as const, askId: "source-one", at: 1_000 };
const CASES: WordsCases<CorrectionWakeKind> = {
  "correction-input": [
    {
      name: "the internal queue summary carries no offer duty",
      wake: {
        facts: {
          kind: "correction-input",
          source,
          state: {
            facts: { latest_captain_reply: "For the next 3 reviews, keep the scope unchanged." },
          },
        },
      },
      words: "A new captain input is queued for a closed question: ask:source-one.",
    },
  ],
  "correction-review": [
    {
      name: "a selected offer recovers saving without another choice",
      wake: { facts: { kind: "correction-review", inputId: 1, source, selected: true } },
      words:
        "The captain requested this project instruction. Use correction_case inspect and recover with inputId 1. Read before retrying an uncertain write. If it is not kept, use the existing app_change direction writer with the offer's stable identifier, exact wording, project and expected revision. No second choice is needed. Do not say kept before verified readback; keep failures pending. Then declare affected work with guide.",
    },
    {
      name: "the one more ask after a turn ended without the save lets the first mate say why",
      wake: {
        facts: { kind: "correction-review", inputId: 1, source, selected: true, retry: true },
      },
      words:
        "The captain's chosen project instruction is still not saved after your turn on it. Use correction_case inspect and recover with inputId 1. If it can be saved, use the existing app_change direction writer with the offer's stable identifier, exact wording, project and expected revision. If it cannot, use correction_case ignore with a reply telling the captain why it was not kept. The app does not ask again.",
    },
    {
      name: "a verified save asks only for affected-work judgment",
      wake: { facts: { kind: "correction-review", inputId: 1, source, saved: true } },
      words:
        "A verified project direction awaits your affected-work judgment. Use correction_case inspect and recover with inputId 1, then guide only affected running task ids, or an empty list. Do not offer or save it again.",
    },
    {
      name: "only a flagged case carries proposal guidance",
      wake: { facts: { kind: "correction-review", inputId: 1, source } },
      words: [
        "A decision model flagged one possible lasting correction. Source: ask:source-one; input: 1.",
        "Only this flagged case needs consideration; the flag is not permission to save or start work. The original author handles the current correction normally.",
        "Use correction_case inspect with inputId to read the source-time text. Check its meaning, intended project, existing directions and earlier offers. A current product request alone need not become a direction.",
        "If useful for later work, use correction_case offer with the exact proposed text and intended project. Preserve all conditions and numbers, including bounded rules; always and repetition are not required. Otherwise use correction_case ignore. Never silently edit project instruction files.",
        "Keep the offer separate from the original task's approval and merge. Reuse an unresolved offer. A declined offer stays declined without new evidence. Projectless work needs an identified project, never an invented one.",
        "After Keep, use the existing app_change direction writer with the offered stable identifier, exact wording and scope. Read before retrying an uncertain write; never overwrite a newer revision. Keep failures pending, and do not say kept before verified readback.",
        "Explicit requests to keep a rule retain your existing authority and require no extra confirmation. Tell only running crewmates whose work the saved change affects; use correction_case guide with their ids after saving. Saving grants no other permission.",
      ].join("\n"),
    },
  ],
  "kept-project-direction": [
    {
      name: "a verified applicable direction keeps its conditions",
      wake: {
        facts: {
          kind: "kept-project-direction",
          id: "d:scope",
          revision: 1,
          text: "For the next 3 reviews, keep the scope unchanged.",
        },
      },
      words:
        "The captain kept this instruction for your project (d:scope, revision 1). Apply it where it concerns your current work; it grants no new permission.\nFor the next 3 reviews, keep the scope unchanged.",
    },
  ],
};
pinWakeWords("correction flow words", CASES);
