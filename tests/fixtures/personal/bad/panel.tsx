import type { PanelProps } from "@firstmate/contracts";
// @ts-expect-error - the point: an npm package the host must refuse by name.
import debounce from "lodash";

/** The refusal fixture: an npm import the compiler must name and refuse. */
export default function Panel({ id }: PanelProps) {
  return <p data-fixture={id}>{String(debounce)}</p>;
}
