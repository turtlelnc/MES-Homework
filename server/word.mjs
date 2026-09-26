import mammoth from "mammoth";
import WordExtractor from "word-extractor";

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC = "application/msword";

export function isWordDocument(mimeType, fileName = "") {
  const lower = fileName.toLowerCase();
  return (
    mimeType === DOCX ||
    mimeType === DOC ||
    lower.endsWith(".docx") ||
    lower.endsWith(".doc")
  );
}

export async function extractWordDocument(filePath, mimeType, fileName = "") {
  const isDocx = mimeType === DOCX || fileName.toLowerCase().endsWith(".docx");
  if (isDocx) {
    const images = [];
    const html = await mammoth.convertToHtml(
      { path: filePath },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const buffer = await image.read();
          if (image.contentType?.startsWith("image/")) {
            images.push({
              mimeType: image.contentType,
              base64: buffer.toString("base64"),
            });
          }
          return { src: "embedded-image" };
        }),
      },
    );
    const raw = await mammoth.extractRawText({ path: filePath });
    const text = raw.value.trim();
    if (!text && !images.length)
      throw new Error("DOCX 中没有可读取的文字或图片");
    return {
      text,
      images,
      warnings: html.messages.map((message) => message.message),
    };
  }

  const extractor = new WordExtractor();
  const document = await extractor.extract(filePath);
  const text = [
    document.getHeaders(),
    document.getBody(),
    document.getFootnotes(),
    document.getEndnotes(),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text)
    throw new Error(
      "旧版 DOC 中没有可读取的文字；请用 Word 另存为 DOCX 或 PDF 后重试",
    );
  return {
    text,
    images: [],
    warnings: [
      "旧版 DOC 仅提取文字，复杂公式、浮动图片和文本框请在草稿中核对。",
    ],
  };
}
