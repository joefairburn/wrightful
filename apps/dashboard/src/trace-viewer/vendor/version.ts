/**
 * The playwright-core version this vendor/ directory was synced from
 * (microsoft/playwright tag v<version>). The files here are faithful copies
 * of that tag's trace-model source; the runtime engine (sw.bundle.js) is
 * separately copied out of the INSTALLED playwright-core by
 * scripts/vendor-trace-viewer.mjs, so the two must describe the same version.
 *
 * `src/__tests__/trace-viewer-vendor.test.ts` fails when the installed
 * playwright-core moves past this constant — bumping the dependency requires
 * re-syncing vendor/ from the matching upstream tag (diff each file against
 * its VENDOR-PROVENANCE path) and then updating this constant.
 */
export const VENDORED_PLAYWRIGHT_VERSION = "1.61.1";
