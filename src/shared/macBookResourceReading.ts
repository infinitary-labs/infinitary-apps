import type { ComputerResourcesView } from "./resources";

/**
 * INF-396: the real 11:32:53 PM MacBook reading (16,384-byte pages, 25,769,803,776
 * installed, 16,436,215,808 used at normal pressure). The panel projection and
 * the read executor share this view, so neither test invents a memory reading.
 * It lives here because the renderer project cannot import a file under tests/.
 */
export const macBookResourcesView: ComputerResourcesView = {
  computers: [
    {
      computerId: null,
      label: "This computer",
      reading: {
        status: "fresh",
        ageMs: 40,
        memoryUsedBytes: 16_436_215_808,
        observation: {
          epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
          sequence: 1,
          status: "sampled",
          sampleMs: 250,
          cpu: { logicalCpus: 10, idleFraction: 0.4 },
          memory: {
            totalBytes: 25_769_803_776,
            freeBytes: 203_997_184,
            purgeableBytes: 377_831_424,
            fileBackedBytes: 5_790_089_216,
            inactiveBytes: 9_075_867_648,
            speculativeBytes: 53_723_136,
            memoryPressure: "normal",
          },
        },
      },
    },
    {
      computerId: "mini",
      label: "Mac mini",
      reading: { status: "unknown", reason: "stale" },
    },
  ],
};
