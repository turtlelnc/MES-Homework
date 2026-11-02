export function normalizeFigure(
  raw: unknown,
): {
  image?: string;
  caption: string;
  shapes: {
    type: string;
    x: number;
    y: number;
    x2: number;
    y2: number;
    r: number;
    text: string;
  }[];
} | null;
