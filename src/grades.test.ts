import { describe, it, expect } from "vitest";
import { questionGrade } from "./grades";
import { normalizeFigure } from "../shared/figure.mjs";
import { referenceAnswer } from "../shared/reference-answer.mjs";
describe("rc1 question presentation", () => {
  it("uses the same boundaries for every question and rejects ungraded values", () => {
    expect(
      [100, 95, 94, 85, 84, 75, 74, 60, 59, 0].map((n) =>
        questionGrade(n, 100),
      ),
    ).toEqual(["A+", "A+", "A", "A", "B+", "B+", "B", "B", "C", "C"]);
    for (const [score, max] of [
      [null, 10],
      [1, 0],
      [11, 10],
      [-1, 10],
      ["oops", 10],
    ])
      expect(questionGrade(score, max)).toBe("待评定");
  });
  it("allows bounded geometry and text only, discarding executable and external shapes", () => {
    expect(
      normalizeFigure({
        shapes: [
          { type: "script", text: "alert(1)" },
          { type: "image", url: "https://example.com" },
          { type: "line", x: -20, x2: 900 },
        ],
      }),
    ).toEqual({
      caption: "",
      shapes: [{ type: "line", x: 0, y: 0, x2: 600, y2: 0, r: 0, text: "" }],
    });
  });
  it("accepts small original raster figures and rejects SVG and remote images", () => {
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    expect(normalizeFigure({ image })?.image).toBe(image);
    expect(
      normalizeFigure({ image: "data:image/svg+xml;base64,PHN2Zz4=" }),
    ).toBe(null);
    expect(normalizeFigure({ image: "https://example.com/image.png" })).toBe(
      null,
    );
    expect(normalizeFigure({ image: "data:image/png;base64,YWJjZA==" })).toBe(
      null,
    );
  });
  it("removes objective marking sections while preserving subjective rubrics", () => {
    expect(referenceAnswer("B\n评分要点：选B得3分", "选择题")).toBe("B");
    expect(referenceAnswer("2；评分标准：填2得满分", "", "fill")).toBe("2");
    expect(referenceAnswer("证明：…\n评分要点：第一步2分", "证明题")).toContain(
      "评分要点",
    );
  });
});
