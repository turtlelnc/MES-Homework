// Mirrors server/version.mjs so the shell can render the release identity
// before the first /api/health round-trip completes.
export const APP_VERSION = "v0.2.2-rc1";
export const BUILD_NUMBER = "26110101";
export const VERSION_LABEL = `${APP_VERSION} (build${BUILD_NUMBER})`;
