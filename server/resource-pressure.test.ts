import { expect, it } from "vitest";
import { createResourcePressure } from "./resource-pressure.mjs";

it("closes heavy admission on high RSS and opens again without a restart", async () => {
  let memory = 0;
  const pressure = createResourcePressure("unused", {
    systemProbe: async () => ({ supported: false }),
    publish: false,
    rss: () => memory,
    recoveryMs: 0,
    probe: async () => ({ bavail: 1024 ** 3, bsize: 1 }),
  });
  try {
    await pressure.ready;
    pressure.assertUpload(1024);
    memory = Number.MAX_SAFE_INTEGER;
    expect(() => pressure.assertMemory()).toThrow(/内存繁忙/);
    memory = 0;
    await pressure.refreshSystem();
    await pressure.refreshSystem();
    pressure.assertUpload(1024);
  } finally {
    pressure.stop();
  }
});

it("never queues disk probes when one is stuck, rejects stale results, and recovers", async () => {
  let time = 100,
    calls = 0,
    stalled = false;
  let finish: (value: any) => void;
  const pressure = createResourcePressure("unused", {
    systemProbe: async () => ({ supported: false }),
    publish: false,
    now: () => time,
    rss: () => 0,
    probe: () => {
      calls++;
      return stalled
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ bavail: 1024 ** 3, bsize: 1 });
    },
  });
  try {
    await pressure.ready;
    pressure.assertUpload();
    stalled = true;
    const pending = pressure.refresh();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) pressure.refresh();
    expect(calls).toBe(2);
    time += 16000;
    expect(() => pressure.assertUpload()).toThrow(/存储暂不可用/);
    finish!({ bavail: 1, bsize: 1 });
    await pending;
    expect(() => pressure.assertUpload()).toThrow(/可用空间不足/);
    stalled = false;
    await pressure.refresh();
    pressure.assertUpload();
  } finally {
    pressure.stop();
  }
});

it("accounts for reservations between disk snapshots instead of repeatedly spending stale free space", async () => {
  const pressure = createResourcePressure("unused", {
    systemProbe: async () => ({ supported: false }),
    publish: false,
    rss: () => 0,
    probe: async () => ({ bavail: 256 * 1024 * 1024, bsize: 1 }),
  });
  try {
    await pressure.ready;
    pressure.assertUpload(100 * 1024 * 1024);
    pressure.chargeDisk(100 * 1024 * 1024);
    expect(() => pressure.assertUpload(180 * 1024 * 1024)).toThrow(
      /可用空间不足/,
    );
    await pressure.refresh();
    pressure.assertUpload(100 * 1024 * 1024);
  } finally {
    pressure.stop();
  }
});

it("reduces admission, pauses parsers and recovers one stage at a time after stable readings", async () => {
  let time = 1000,
    available = 2 * 1024 ** 3;
  const pressure = createResourcePressure("unused", {
    publish: false,
    rss: () => 0,
    now: () => time,
    lag: () => 0,
    probe: async () => ({ bavail: 1024 ** 3, bsize: 1 }),
    systemProbe: async () => ({
      supported: true,
      totalBytes: 4 * 1024 ** 3,
      availableBytes: available,
      memorySome: 0,
      memoryFull: 0,
      ioFull: 0,
      swapPagesPerSecond: 0,
    }),
  });
  try {
    await pressure.ready;
    expect(pressure.limit(2)).toBe(2);
    available = 400 * 1024 ** 2;
    await pressure.refreshSystem();
    expect(pressure.limit(2)).toBe(1);
    expect(() => pressure.assertParser()).toThrow(/暂缓/);
    available = 100 * 1024 ** 2;
    await pressure.refreshSystem();
    expect(pressure.limit(2)).toBe(0);
    expect(() => pressure.assertMemory()).toThrow(/繁忙/);
    available = 2 * 1024 ** 3;
    await pressure.refreshSystem();
    expect(pressure.limit(2)).toBe(0);
    time += 31000;
    await pressure.refreshSystem();
    expect(pressure.limit(2)).toBe(1);
    time += 31000;
    await pressure.refreshSystem();
    expect(pressure.limit(2)).toBe(2);
    pressure.assertParser();
  } finally {
    pressure.stop();
  }
});
it("bounds a stalled system probe and closes heavy admission when its last good reading is stale", async () => {
  let time = 1000,
    stalled = false,
    calls = 0;
  let finish: (value: any) => void;
  const normal = {
    supported: true,
    totalBytes: 4 * 1024 ** 3,
    availableBytes: 2 * 1024 ** 3,
    memorySome: 0,
    memoryFull: 0,
    ioFull: 0,
    swapPagesPerSecond: 0,
  };
  const pressure = createResourcePressure("unused", {
    publish: false,
    rss: () => 0,
    now: () => time,
    lag: () => 0,
    probe: async () => ({ bavail: 1024 ** 3, bsize: 1 }),
    systemProbe: () => {
      calls++;
      return stalled
        ? new Promise((r) => {
            finish = r;
          })
        : Promise.resolve(normal);
    },
  });
  try {
    await pressure.ready;
    stalled = true;
    const pending = pressure.refreshSystem();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) pressure.refreshSystem();
    expect(calls).toBe(2);
    time += 16000;
    expect(pressure.limit(2)).toBe(0);
    expect(pressure.snapshot().reasons).toContain("monitor_stale");
    finish!(normal);
    await pending;
    expect(pressure.limit(2)).toBe(0);
  } finally {
    pressure.stop();
  }
});
