import fs from "node:fs";
import { APP_VERSION, BUILD_NUMBER } from "../../server/version.mjs";
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== APP_VERSION
)
  throw new Error("Release tag does not match source version");
const values = `DEPLOYER_VERSION=${APP_VERSION}\nDEPLOYER_BUILD=${BUILD_NUMBER}\n`;
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, values);
else process.stdout.write(values);
