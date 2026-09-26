import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import fs from "node:fs";

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;

export async function documentImages(filePath, mimeType, maxPages = 10) {
  const source = fs.readFileSync(filePath);
  if (mimeType !== "application/pdf") {
    return [{ mimeType, base64: source.toString("base64") }];
  }

  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({
    data: new Uint8Array(source),
    disableWorker: true,
    useSystemFonts: true,
  }).promise;
  if (pdf.numPages > maxPages) {
    throw new Error(`PDF 共 ${pdf.numPages} 页，单次最多识别 ${maxPages} 页，请拆分后上传`);
  }
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    const canvasContext = canvas.getContext("2d");
    await page.render({ canvas, canvasContext, viewport }).promise;
    pages.push({
      mimeType: "image/jpeg",
      base64: canvas.toBuffer("image/jpeg", 88).toString("base64"),
    });
    page.cleanup();
  }
  if (typeof pdf.cleanup === "function") await pdf.cleanup();
  return pages;
}

export function cleanModelJson(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1].trim() : text);
}
