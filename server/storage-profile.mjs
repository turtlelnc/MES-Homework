import fs from "node:fs";
import path from "node:path";
export function storageProfile(location) {
  let directory = path.resolve(location);
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("无法定位存储文件系统");
    directory = parent;
  }
  const stats = fs.statfsSync(directory);
  return {
    totalBytes: stats.blocks * stats.bsize,
    freeBytes: stats.bavail * stats.bsize,
    blockBytes: stats.bsize,
  };
}
