type Shape = {
  type: string;
  x: number;
  y: number;
  x2: number;
  y2: number;
  r: number;
  text: string;
};
export type Figure = { image?: string; caption: string; shapes: Shape[] };
export function QuestionFigure({ figure }: { figure?: Figure | null }) {
  if (!figure || (!figure.image && !figure.shapes?.length)) return null;
  return (
    <figure className="question-figure">
      {figure.image ? (
        <img src={figure.image} alt={figure.caption || "原题附图"} />
      ) : (
        <svg
          viewBox="0 0 600 600"
          role="img"
          aria-label={figure.caption || "题目附图"}
        >
          {figure.shapes.map((s, i) =>
            s.type === "line" ? (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={s.x2}
                y2={s.y2}
                stroke="currentColor"
                strokeWidth="2"
              />
            ) : s.type === "circle" ? (
              <circle
                key={i}
                cx={s.x}
                cy={s.y}
                r={s.r}
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
              />
            ) : s.type === "text" ? (
              <text key={i} x={s.x} y={s.y} fontSize="24">
                {s.text}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {figure.caption && <figcaption>{figure.caption}</figcaption>}
    </figure>
  );
}
