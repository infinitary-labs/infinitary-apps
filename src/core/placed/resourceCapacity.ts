import type { LoadDemand } from "@shared/load";
import type { ComputerResourceReading } from "@shared/resources";

/** Memory kept back from placement and admission: the greater of 512 MiB or 10 percent. */
export function memoryMarginBytes(totalBytes: number): number {
  return Math.max(512 * 1024 ** 2, totalBytes * 0.1);
}

/** The existing placement margins, shared with declared heavy-run admission. */
export function resourceCapacity(reading: ComputerResourceReading): LoadDemand | null {
  if (reading.status !== "fresh" || reading.memoryUsedBytes === undefined) return null;
  const { cpu, memory } = reading.observation;
  const usable = memory.totalBytes - reading.memoryUsedBytes;
  return {
    cpu: cpu.logicalCpus * cpu.idleFraction * 0.8,
    memoryBytes: Math.max(0, Math.floor(usable - memoryMarginBytes(memory.totalBytes))),
  };
}
