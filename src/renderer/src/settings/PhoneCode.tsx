import { useMemo } from "react";
import { PHONE_CODE_QUIET, phoneCodeModules } from "../../../shared/phoneCode";

/** The one-use link, encoded locally; neither a request nor a saved picture. */
export function PhoneCode({ link }: { link: string }) {
  const { size, path } = useMemo(() => {
    const modules = phoneCodeModules(link);
    const cells: string[] = [];
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) cells.push(`M${x + PHONE_CODE_QUIET} ${y + PHONE_CODE_QUIET}h1v1h-1z`);
      });
    });
    return { size: modules.length + 2 * PHONE_CODE_QUIET, path: cells.join("") };
  }, [link]);
  return (
    <svg
      data-phone-code=""
      className="inf-phone-code"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Scan this code inside Infinitary on your phone"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
