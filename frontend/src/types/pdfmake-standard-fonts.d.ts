/**
 * pdfmake ships prebuilt standard-14 font containers under
 * `pdfmake/build/standard-fonts/`, but `@types/pdfmake` declares only the
 * main bundle and the Roboto VFS - there are no typings for these. The
 * modules are plain CommonJS files whose single export is a
 * `TFontContainer` (`{ vfs, fonts }`), so declaring that here is exact,
 * not a convenience `any`.
 *
 * Only Helvetica is declared: it is the one the rota PDF export uses
 * (Design Decision 2). Add the others here if a future export needs them.
 */
declare module "pdfmake/build/standard-fonts/Helvetica" {
  import type { TFontContainer } from "pdfmake/interfaces";

  const fontContainer: TFontContainer;
  export default fontContainer;
}
