// LC_BUILD_VERSION also contains linker tool versions. Only minos is an OS
// requirement; interpreting the tool's "version" would invent an OS floor.
export function minimumMacOS(outputs) {
  const versions = outputs.flatMap((output) =>
    output.split(/Load command \d+/).flatMap((block) => {
      const build = /cmd LC_BUILD_VERSION\b/.test(block),
        legacy = /cmd LC_VERSION_MIN_MACOSX\b/.test(block);
      if (!build && !legacy) return [];
      const match = block.match(
        build
          ? /^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$/m
          : /^\s*version\s+(\d+(?:\.\d+){1,2})\s*$/m,
      );
      return match ? [match[1]] : [];
    }),
  );
  if (!versions.length)
    throw new Error(
      "Cannot derive macOS minimum from Mach-O deployment commands",
    );
  return versions
    .sort((a, b) => {
      const x = a.split(".").map(Number),
        y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
      }
      return 0;
    })
    .at(-1);
}
