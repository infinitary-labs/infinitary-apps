import type { CustomModelCost } from "@shared/customApi";
import * as m from "@shared/i18n/messages.generated";
import { useState } from "react";
import { Input } from "../design";
import { FormInput } from "./FormInput";

export const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type PriceKey = (typeof PRICE_KEYS)[number];
/** The prices as typed, so a half-typed "0." stays on screen. */
export type PriceText = Partial<Record<PriceKey, string>>;

const LABEL: Record<PriceKey, () => string> = {
  input: m.accountsCustomApiPriceInput,
  output: m.accountsCustomApiPriceOutput,
  cacheRead: m.accountsCustomApiPriceCacheRead,
  cacheWrite: m.accountsCustomApiPriceCacheWrite,
};

export function priceText(cost: CustomModelCost | undefined): PriceText {
  return Object.fromEntries(
    PRICE_KEYS.flatMap((key) => (cost?.[key] === undefined ? [] : [[key, String(cost[key])]])),
  );
}

/** A typed price that is not a plain non-negative number of dollars; blank is fine. */
const badPrice = (text: string | undefined) => {
  const typed = text?.trim();
  return Boolean(typed) && !/^\d+(\.\d+)?$/.test(typed ?? "");
};

/**
 * The prices to save: undefined when every one is blank, "invalid" when one
 * is not a plain non-negative number of dollars.
 */
export function typedCost(text: PriceText | undefined): CustomModelCost | undefined | "invalid" {
  const cost: CustomModelCost = {};
  for (const key of PRICE_KEYS) {
    if (badPrice(text?.[key])) return "invalid";
    const typed = text?.[key]?.trim();
    if (typed) cost[key] = Number(typed);
  }
  return Object.keys(cost).length ? cost : undefined;
}

/** Free is every price stated as zero, the same thing the four fields say. */
const isFree = (text: PriceText | undefined) =>
  PRICE_KEYS.every((key) => {
    const typed = text?.[key]?.trim();
    return typed !== undefined && typed !== "" && Number(typed) === 0;
  });

/** A model line's optional name and prices, folded until opened. */
export function CustomModelPrice({
  idPrefix,
  name,
  prices,
  invalid,
  onChange,
}: {
  idPrefix: string;
  name: string;
  prices: PriceText | undefined;
  invalid: boolean;
  onChange: (change: { name?: string; prices?: PriceText }) => void;
}) {
  // Opened when it already says something; after that, only the person folds it.
  const [open] = useState(
    () => Boolean(name.trim()) || PRICE_KEYS.some((key) => prices?.[key]?.trim()),
  );
  return (
    <details className="fm-custom-price" open={open} data-custom-price>
      <summary>{m.accountsCustomApiPriceTitle()}</summary>
      <div className="fm-custom-price-body">
        <label className="fm-custom-field fm-custom-price-name" htmlFor={`${idPrefix}-name`}>
          <span>{m.accountsCustomApiPriceName()}</span>
          <Input
            id={`${idPrefix}-name`}
            autoComplete="off"
            maxLength={128}
            value={name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        {PRICE_KEYS.map((key) => {
          const wrong = invalid && badPrice(prices?.[key]);
          return (
            <label key={key} className="fm-custom-field" htmlFor={`${idPrefix}-${key}`}>
              <span>{LABEL[key]()}</span>
              <FormInput
                id={`${idPrefix}-${key}`}
                mono
                inputMode="decimal"
                autoComplete="off"
                placeholder="$"
                invalid={wrong}
                value={prices?.[key] ?? ""}
                onChange={(event) => onChange({ prices: { ...prices, [key]: event.target.value } })}
              />
            </label>
          );
        })}
        <label className="fm-custom-choice fm-custom-price-free">
          <input
            type="checkbox"
            checked={isFree(prices)}
            onChange={(event) =>
              onChange({
                prices: Object.fromEntries(
                  PRICE_KEYS.map((key) => [key, event.target.checked ? "0" : ""]),
                ),
              })
            }
          />
          <span>{m.accountsCustomApiPriceFree()}</span>
        </label>
        <p className="fm-custom-hint">{m.accountsCustomApiPriceHint()}</p>
      </div>
    </details>
  );
}
