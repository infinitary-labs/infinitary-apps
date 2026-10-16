import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** The one-use link, encoded locally; neither a request nor a saved picture. */
export function PhoneCode({ link }: { link: string }) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(link, "Byte");
    code.make();
    const size = code.getModuleCount();
    const cells: string[] = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (code.isDark(y, x)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    return { size: size + 8, path: cells.join("") };
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
