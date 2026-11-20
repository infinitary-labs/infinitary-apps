import qrcode from "qrcode-generator";

/**
 * A phone's code for a one-use link (docs/ios.md, "Joining and trust"): the
 * QR code the phone scans, made here and never fetched or saved. Settings ->
 * Devices draws it (`PhoneCode`, src/renderer/src/settings/PhoneCode.tsx) and
 * `infinitary link --phone` prints it (src/main/linkCommand.ts), from the
 * same modules: rows of the code, `true` where a module is dark, without the
 * quiet zone each drawing adds around it.
 */
export function phoneCodeModules(link: string): boolean[][] {
  const code = qrcode(0, "M");
  code.addData(link, "Byte");
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => code.isDark(y, x)),
  );
}

/** The light margin around the code a reader needs, in modules, on every side. */
export const PHONE_CODE_QUIET = 4;
