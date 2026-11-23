/** One file's osx-sign options, as electron-builder's `optionsForFile` gives them. */
export type FileSignOptions = Record<string, unknown> & { requirements?: string };
/** electron-builder's signer options, as its `mac.sign` hook receives them. */
export type MacSignConfiguration = Record<string, unknown> & {
  app: string;
  optionsForFile?: (filePath: string) => FileSignOptions;
};
/** The signer's options: electron-builder's, with the release's designated requirement on the app bundle and its background file. */
export function releaseSignOptions<Configuration extends MacSignConfiguration>(
  configuration: Configuration,
): Configuration & { optionsForFile: (filePath: string) => FileSignOptions };
/** electron-builder's `mac.sign` hook for the release. */
export function sign(configuration: MacSignConfiguration): Promise<void>;
export default sign;
