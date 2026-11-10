import seed from "./card-annotation-review";

export { asked } from "./card-annotation-review";
export default async function seedDrawing(userDataDir: string): Promise<void> {
  await seed(userDataDir, { drawing: true });
}
