import { APP_VERSION, BUILD_NUMBER } from "../../server/version.mjs";
export function packageVersions(version = APP_VERSION, build = BUILD_NUMBER) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d+))?$/.exec(
    version,
  );
  if (!match || !/^\d+$/.test(String(build)))
    throw new Error("Unsupported release identity");
  const [, major, minor, patch, phase, sequence] = match;
  const channel = { alpha: 100, beta: 200, rc: 500 };
  if (Number(sequence || 0) > 99)
    throw new Error("Prerelease sequence exceeds native version policy");
  const revision =
    Number(patch) * 1000 + (phase ? channel[phase] + Number(sequence) : 999);
  if (Number(major) > 255 || Number(minor) > 255 || revision > 65535)
    throw new Error("Version cannot be represented by Windows Installer");
  const base = `${major}.${minor}.${patch}`,
    suffix = phase ? `${phase}${sequence}` : "";
  return {
    version: version.startsWith("v") ? version : `v${version}`,
    build: String(build),
    native: `${major}.${minor}.${revision}`,
    short: base,
    deb: `${base}${suffix ? "~" + suffix : ""}+build${build}`,
    rpmVersion: base,
    rpmRelease: `${suffix ? "0." + suffix : "1"}.${build}`,
  };
}
