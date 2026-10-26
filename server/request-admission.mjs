import { runtimeProfile } from "./runtime-profile.mjs";
// A finite number of request contexts can wait on hashing, disk or upstreams.
// Eight contexts per available CPU is an explicit queue policy, not an RPS claim.
export function requestAdmission({
  maxActive = runtimeProfile().httpActive,
} = {}) {
  let active = 0;
  return (req, res, next) => {
    if (req.path === "/health" || req.path === "/capabilities") return next();
    if (active >= maxActive)
      return res
        .set("Retry-After", "5")
        .status(503)
        .json({ error: "服务繁忙，请稍后重试" });
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        active--;
        released = true;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}
