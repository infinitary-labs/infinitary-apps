import { mountCardStage } from "./cardStage";

// The stage part's entry: the generator bundles this file, and the reader
// puts the bundle where the body names the part, so it runs once, after the
// markup is read, as every card script does (docs/card-authoring.md,
// "Scripting").
mountCardStage();
