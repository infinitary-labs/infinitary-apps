import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // A translated page's fingerprint of the English page it was written
        // from (docs/docs-site.md, "Languages"); node scripts/docs-site-languages.ts
        // stamps it and refuses one the English page has moved past.
        source: z.string().optional(),
      }),
    }),
  }),
  // Starlight's own words for a language it brings none for (docs/docs-site.md, "Languages").
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
