import type { Core } from "@core/index";
import { inLanguage } from "@shared/i18n/current";
import * as m from "@shared/i18n/messages.generated";
import { wordedCardText } from "@shared/i18n/said";

const TARGET = "harbour-charts";
const MOVED = "harbour-tides";

/** The move card's id: one card per project the repositories join. */
function moveCardId(core: Core): string {
  const target = core.services.repos.list().find((repo) => repo.name === TARGET);
  const project = target && core.services.repos.projectOf(target.id);
  if (!project) throw new Error(`${TARGET} has no project`);
  return `card-project-change-project-move-${project.id}`;
}

/**
 * The phone languages part's move card (INF-5005, the captain's answer to its
 * review: translate the move card): the home proposes moving one repository
 * into another project, as the first mate does on a card, and answers, in
 * every language the part asks for, the card's title and each button's id and
 * words, worded by their owner (`wordedCardText`) from the card it wrote, and
 * the body's opening sentence as the catalog words it, beside the names the
 * title fills in, which the phone may set apart as their own direction.
 */
export async function raiseMoveCard(
  core: Core,
  tags: readonly string[],
): Promise<
  Record<string, { title: string; names: string[]; actions: Record<string, string>; asks: string }>
> {
  const setup = async (name: string, key: string) =>
    (await core.dispatch("inf:repos:setup", [{ kind: "init", name, key }])).repo;
  await setup(TARGET, "HBC");
  const moved = await setup(MOVED, "HBT");
  await core.services.projectChanges.request(
    "project-move",
    { repoIds: [moved.id], project: "HBC" },
    { kind: "firstmate", wake: "other" },
  );
  const id = moveCardId(core);
  const card = core.services.supervisor.cards.snapshot().find((shown) => shown.id === id);
  if (!card) throw new Error(`The move card into ${TARGET} is not up`);
  core.services.supervisor.cards.flushBroadcast();
  return Object.fromEntries(
    tags.map((tag) => [
      tag,
      inLanguage(tag, () => ({
        title: wordedCardText(card.title, card.body),
        names: [MOVED, TARGET],
        actions: Object.fromEntries(
          (card.actions ?? []).map((action) => [
            action.id,
            wordedCardText(action.label, card.body),
          ]),
        ),
        asks: m.projectsMoveAsks({ count: 1 }),
      })),
    ]),
  );
}

/** Opens the answered move card again, as its notice does. */
export function showMoveCardPast(core: Core): Promise<unknown> {
  return core.dispatch("inf:cards:show-past", [moveCardId(core)]);
}
