import { PlacedWorkScores } from "../routing/placedWork";
import type { AppDatabase } from "../storage/db";
import { registerTaskSearch, selectTasks } from "../storage/taskSelection";
import type { RecordChild, RecordParent } from "./protocol";

/** Owns the reader's scoring state and one committed work snapshot per incoming batch. */
export class RecordReadEngine {
  private readonly scores: PlacedWorkScores;
  private prices: Record<string, number> = {};
  private readonly observations = new Map<string, string>();

  constructor(private readonly db: AppDatabase) {
    registerTaskSearch(db);
    this.scores = new PlacedWorkScores(db, {
      getAllowancePrices: () => ({ ...this.prices }),
      setAllowancePrices: (next) => {
        this.prices = next;
      },
    });
  }

  batch(reads: Extract<RecordParent, { type: "batch" }>["reads"]): RecordChild[] {
    try {
      return this.db.transaction(() => {
        for (const { request } of reads) {
          if (request.kind !== "placed") continue;
          this.prices = { ...request.input.prices, ...this.prices };
          for (const observation of request.input.observations) {
            // Callers replay current readings so a restarted reader can seed itself.
            // Equal replays must not repeat learning's usage queries per start.
            const value = JSON.stringify(observation.snapshot);
            if (this.observations.get(observation.source) === value) continue;
            this.scores.observe(observation.source, observation.snapshot);
            this.observations.set(observation.source, value);
          }
        }
        const placed = reads.find(
          (read) => read.request.kind === "placed" && read.request.input.rows.length > 0,
        );
        const data =
          placed?.request.kind === "placed"
            ? this.scores.data(placed.request.input.now)
            : undefined;
        return reads.map(({ id, request }): RecordChild => {
          try {
            const answer =
              request.kind === "tasks"
                ? selectTasks(this.db, request.input)
                : {
                    data: data
                      ? this.scores.preparedCharges(request.input.rows, data)
                      : { work: [], samples: [], charges: {} },
                    prices: this.prices,
                  };
            return { type: "answer", id, answer };
          } catch (error) {
            return { type: "error", id, message: String(error) };
          }
        });
      })();
    } catch (error) {
      return reads.map(({ id }): RecordChild => ({ type: "error", id, message: String(error) }));
    }
  }
}
