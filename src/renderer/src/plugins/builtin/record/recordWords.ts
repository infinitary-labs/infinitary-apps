import { languageLocale } from "@shared/i18n/current";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";

/**
 * A word the record's frame draws: a plain string, a template whose
 * `{placeholder}` the frame fills, or one template per plural form of the
 * window's language, whose `{count}` the frame writes in `locale`.
 */
export type RecordWord = string | Partial<Record<Intl.LDMLPluralRule, string>>;

/** The record's words, worded in the window's language, as its template carries them. */
export interface RecordWords {
  /** The locale the frame picks plural forms and writes counts in. */
  locale: string;
  words: Record<string, RecordWord>;
}

/**
 * One template per plural form of the current language: each form's
 * message called with a count that picks it, the count written back as
 * `{count}`. The samples reach a million, which picks the `many` form
 * French, Spanish and Portuguese keep for large round numbers; a form no
 * sample picks is left out, and the frame falls back to `other` for it.
 */
const PLURAL_SAMPLES = [...Array.from({ length: 201 }, (_, n) => n), 1_000_000];

function plural(message: (input: { count: number }) => string): RecordWord {
  const rules = new Intl.PluralRules(languageLocale());
  const forms: Partial<Record<Intl.LDMLPluralRule, string>> = {};
  for (const category of rules.resolvedOptions().pluralCategories) {
    for (const sample of PLURAL_SAMPLES) {
      if (rules.select(sample) !== category) continue;
      forms[category] = message({ count: sample }).replace(formatNumber(sample), "{count}");
      break;
    }
  }
  return forms;
}

/**
 * The task record frame's words (docs/i18n.md, "The task record's frame").
 * The frame is plain script served as text and cannot import the catalog,
 * so the window words it at draw time and stamps the result on the
 * template (`recordTemplate`); a language change mounts the frame anew.
 * `home` names the computer where the first mate lives, from a view of it;
 * absent, it is this computer.
 */
export function recordWords(home?: string): RecordWords {
  return {
    locale: languageLocale(),
    words: {
      recordAgeJustNow: m.recordAgeJustNow(),
      recordAgeMinutes: plural(m.recordAgeMinutes),
      recordAgeHours: plural(m.recordAgeHours),
      recordAgeDays: plural(m.recordAgeDays),
      recordAgeShortNow: m.recordAgeShortNow(),
      recordAgeShortMinutes: m.recordAgeShortMinutes({ minutes: "{minutes}" }),
      recordAgeShortHours: m.recordAgeShortHours({ hours: "{hours}" }),
      recordAgeShortDays: m.recordAgeShortDays({ days: "{days}" }),
      recordCardPutAside: m.recordCardPutAside(),
      recordCardOnStage: m.recordCardOnStage(),
      recordCardClosed: m.recordCardClosed(),
      recordCardNote: m.recordCardNote(),
      recordCardDecision: m.recordCardDecision(),
      recordUseFinding: m.recordUseFinding(),
      recordUseConcept: m.recordUseConcept(),
      recordUseCurrentRevision: m.recordUseCurrentRevision({ revision: "{revision}" }),
      recordUseEarlierRevision: m.recordUseEarlierRevision({
        revision: "{revision}",
        current: "{current}",
      }),
      recordUseRetired: m.recordUseRetired(),
      recordUsesMore: plural(m.recordUsesMore),
      recordSourceGone: m.recordSourceGone(),
      recordRecordedDetails: m.recordRecordedDetails(),
      recordFoldedMore: plural(m.recordFoldedMore),
      recordFromTask: m.recordFromTask({ key: "{key}" }),
      recordUndated: m.recordUndated({ summary: "{summary}" }),
      recordFactResult: m.recordFactResult(),
      recordFactOperation: m.recordFactOperation(),
      recordFactCrewmate: m.recordFactCrewmate(),
      recordCrewmateOnModel: m.recordCrewmateOnModel({ crewmate: "{crewmate}", model: "{model}" }),
      recordFactBranch: m.recordFactBranch(),
      recordModeDirectPr: m.recordModeDirectPr(),
      recordModeQueuePr: m.recordModeQueuePr(),
      recordModeLocalOnly: m.recordModeLocalOnly(),
      recordModeInPlace: m.recordModeInPlace(),
      recordCareQuick: m.recordCareQuick(),
      recordCareDefault: m.recordCareDefault(),
      recordCareCareful: m.recordCareCareful(),
      recordLandsMerged: m.recordLandsMerged(),
      recordLandsCare: m.recordLandsCare({ care: "{care}" }),
      recordPolicyThisTask: m.recordPolicyThisTask(),
      recordPolicyParentTask: m.recordPolicyParentTask(),
      recordPolicyProject: m.recordPolicyProject(),
      recordFactDelivery: m.recordFactDelivery(),
      recordDeliveryPullRequest: m.recordDeliveryPullRequest(),
      recordDeliveryBatched: m.recordDeliveryBatched(),
      recordDeliveryLocalMerge: m.recordDeliveryLocalMerge(),
      recordFactMerging: m.recordFactMerging(),
      recordMergingOnItsOwn: m.recordMergingOnItsOwn(),
      recordMergingAsksFirst: m.recordMergingAsksFirst(),
      recordFactCare: m.recordFactCare(),
      recordFactRunsOn: m.recordFactRunsOn(),
      recordFactPersonal: m.recordFactPersonal(),
      recordPersonalVersion: m.recordPersonalVersion({
        version: "{version}",
        when: "{when}",
        computer: "{computer}",
      }),
      recordPersonalNone: m.recordPersonalNone({ computer: "{computer}" }),
      // The computer where the first mate lives, as a version it read there
      // names it: this computer, or by its name from a view of it.
      recordPersonalHome: home ?? m.placeThisComputer(),
      recordFactComputerChoice: m.recordFactComputerChoice(),
      recordComparedComputers: m.recordComparedComputers(),
      recordHelperLocalCare: m.recordHelperLocalCare(),
      recordHelperClosed: m.recordHelperClosed(),
      recordHelperAskFirstMate: m.recordHelperAskFirstMate(),
      recordMoreKnowledge: plural(m.recordMoreKnowledge),
      recordMoreValidation: m.recordMoreValidation(),
      recordMoreBranch: m.recordMoreBranch(),
      recordMoreComputerChoice: m.recordMoreComputerChoice(),
      recordMoreDelivery: m.recordMoreDelivery(),
      recordValidationScenario: m.recordValidationScenario(),
      recordValidationResult: m.recordValidationResult(),
      recordValidationEvidence: m.recordValidationEvidence(),
      recordValidationSupplementary: m.recordValidationSupplementary({ action: "{action}" }),
      recordOpenKeptEvidence: m.recordOpenKeptEvidence(),
      recordShowEarlier: plural(m.recordShowEarlier),
      recordUnreadable: m.recordUnreadable(),
      recordLabelMore: m.recordLabelMore(),
      recordLabelKnowledgeUsed: m.recordLabelKnowledgeUsed(),
      recordKnowledgeUsedNote: m.recordKnowledgeUsedNote(),
      recordLabelLiveValidation: m.recordLabelLiveValidation(),
    },
  };
}
