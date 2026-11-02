// A bounded vector description, never executable SVG/HTML or external URLs.
export function normalizeFigure(raw) {
  if (!raw || typeof raw !== "object") return null;
  const coord = (v) => Math.max(0, Math.min(600, Number(v) || 0));
  const shapes = (Array.isArray(raw.shapes) ? raw.shapes : [])
    .slice(0, 120)
    .flatMap((s) => {
      if (!s || !["line", "circle", "text"].includes(s.type)) return [];
      return [
        {
          type: s.type,
          x: coord(s.x),
          y: coord(s.y),
          x2: coord(s.x2),
          y2: coord(s.y2),
          r: Math.min(300, coord(s.r)),
          text: typeof s.text === "string" ? s.text.slice(0, 120) : "",
        },
      ];
    });
  let image;
  if (typeof raw.image === "string" && raw.image.length <= 350000) {
    const match = raw.image.match(
      /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
    );
    if (match) {
      const bytes = Buffer.from(match[2], "base64");
      const valid =
        match[1] === "png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : match[1] === "jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.toString("ascii", 0, 4) === "RIFF" &&
              bytes.toString("ascii", 8, 12) === "WEBP";
      if (valid) image = raw.image;
    }
  }
  return shapes.length || image
    ? {
        shapes,
        ...(image ? { image } : {}),
        caption:
          typeof raw.caption === "string" ? raw.caption.slice(0, 300) : "",
      }
    : null;
}
