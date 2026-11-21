import seed from "./card-annotation-review";

export { asked } from "./card-annotation-review";
/** The approved annotation example with its real drawing, which the viewer opens and marks. */
export default async function seedDrawing(userDataDir: string): Promise<void> {
  await seed(userDataDir, { drawing: true });
}
