// Single source of truth for the server-reported release identity.
// Keep in sync with package.json and src/version.ts (asserted by version.test.ts).
export const APP_VERSION = "v0.2.1-rc1";
export const BUILD_NUMBER = "26102401";
export const VERSION_LABEL = `${APP_VERSION} (build${BUILD_NUMBER})`;
