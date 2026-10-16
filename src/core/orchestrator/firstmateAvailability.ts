import type { Flagship } from "./flagship";

type ModelRef = { provider: string; id: string };
/** Local serving facts for the selected model, not gate closure or a paid health probe. */
export function firstmateCanServe(options: {
  local: boolean;
  model: ModelRef | undefined;
  available: readonly ModelRef[];
  custom: readonly ModelRef[];
  accounts: readonly { accountId: string; models: readonly ModelRef[] }[];
  flagship: Pick<Flagship, "servesFirstmate" | "resolveAccountId" | "pause">;
}): boolean {
  if (options.local) return true;
  const model = options.model;
  if (!model || !options.available.some((entry) => same(entry, model))) return false;
  if (!options.flagship.servesFirstmate(model.provider)) return false;
  const accountId = options.flagship.resolveAccountId(model.provider);
  if (!accountId) return options.custom.some((entry) => same(entry, model));
  return (
    !options.flagship.pause(accountId) &&
    options.accounts.some(
      (row) => row.accountId === accountId && row.models.some((entry) => same(entry, model)),
    )
  );
}

function same(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}
