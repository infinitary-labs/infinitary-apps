import { BaseSequencer, type TestSpecification } from "vitest/node";

export default class FixtureSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return files.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}
