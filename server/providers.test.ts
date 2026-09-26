import { describe, expect, it } from "vitest";
import { providers } from "./providers.mjs";

describe("rc4 provider presets", () => {
  it("ships ten configurable vendors", () => {
    expect(Object.keys(providers)).toHaveLength(10);
    expect(providers.deepseek.vision).toBe(true);
    expect(providers.qwen.vision).toBe(true);
    expect(providers.minimax.vision).toBe(false);
  });

  it("removes the university stage from the application", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../src/main.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('const stages = ["小学", "初中", "高中"]');
    expect(source).not.toContain('"大学"');
  });
});
