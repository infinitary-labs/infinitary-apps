import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { balanceShards, readShardTimings } from "../../scripts/shard-balance.ts";

/**
 * vitest's --shard, balanced by each file's measured time (INF-2674).
 *
 * A run whose files have no measured time at all (the integration, probe and
 * browser groups) keeps vitest's own split by path hash, unchanged. A run
 * with measured files (the unit groups) gives each group about the same time;
 * a file missing from the record weighs a typical file until
 * scripts/shard-timings.ts measures it.
 */
export default class TimeBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const timings = readShardTimings();
    const root = this.ctx.config.root;
    const pathOf = (spec: TestSpecification) => relative(root, spec.moduleId);
    if (!files.some((spec) => pathOf(spec) in timings)) return super.shard(files);
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const mine = new Set(balanceShards(files.map(pathOf), count, timings)[index - 1]);
    return files.filter((spec) => mine.has(pathOf(spec)));
  }
}
