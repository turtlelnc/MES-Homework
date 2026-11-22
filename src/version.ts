// Mirrors server/version.mjs so the shell can render the release identity
// before the first /api/health round-trip completes.
export const APP_VERSION = "v0.2.3-rc8";
export const BUILD_NUMBER = "26112202";
export const VERSION_LABEL = `${APP_VERSION} (build${BUILD_NUMBER})`;
