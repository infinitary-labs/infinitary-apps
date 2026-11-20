import seed from "./card-annotation-review";

export { asked } from "./card-annotation-review";

/** The same real annotation fixture, with repeated parts and a host-refreshed merge strip. */
export default async function seedRepeatedMerge(userDataDir: string): Promise<void> {
  await seed(userDataDir, { repeatedMerge: true });
}
