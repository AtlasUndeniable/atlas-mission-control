export interface BrandedWorkspacePdfInput {
  title: string;
  createdAt: string;
  markdown: string;
}

type PdfTextStyle = "eyebrow" | "coverTitle" | "coverMeta" | "heading" | "body" | "small";

type PdfBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string }
  | { type: "spacer" };

interface PdfTextLine {
  kind: "text";
  style: PdfTextStyle;
  text: string;
}

interface PdfRuleLine {
  kind: "rule";
}

interface PdfSpacerLine {
  kind: "spacer";
  height: number;
}

type PdfLine = PdfTextLine | PdfRuleLine | PdfSpacerLine;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const BODY_TOP = 704;
const BODY_BOTTOM = 72;
const ACCENT_RGB = "0.831 0.659 0.341";
const DARK_RGB = "0.071 0.071 0.082";
const LIGHT_RGB = "0.965 0.965 0.945";
const TEXT_RGB = "0.108 0.108 0.122";
const MUTED_RGB = "0.382 0.382 0.420";

export function renderBrandedWorkspacePdf(input: BrandedWorkspacePdfInput): Buffer {
  const createdLabel = formatPdfDate(input.createdAt);
  const bodyLines = layoutBodyLines(markdownToBrandedPdfBlocks(input.markdown));
  const pages = paginatePdfLines(bodyLines);
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const addObject = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("__PAGES__");
  const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  void catalogId;
  void pagesId;

  const cover = coverPageContent({
    title: input.title,
    createdLabel,
    pageNumber: 1,
    pageCount: pages.length + 1,
  });
  const coverContentId = addObject(`<< /Length ${Buffer.byteLength(cover, "ascii")} >>\nstream\n${cover}\nendstream`);
  pageObjectIds.push(addPageObject(addObject, fontRegularId, fontBoldId, coverContentId));

  pages.forEach((pageLines, index) => {
    const content = bodyPageContent({
      title: input.title,
      lines: pageLines,
      pageNumber: index + 2,
      pageCount: pages.length + 1,
    });
    const contentId = addObject(`<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`);
    pageObjectIds.push(addPageObject(addObject, fontRegularId, fontBoldId, contentId));
  });

  objects[pagesId - 1] = [
    "<< /Type /Pages",
    `/Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}]`,
    `/Count ${pageObjectIds.length}`,
    ">>",
  ].join(" ");

  return buildPdf(objects);
}

function addPageObject(
  addObject: (body: string) => number,
  fontRegularId: number,
  fontBoldId: number,
  contentId: number,
): number {
  return addObject([
    "<< /Type /Page",
    "/Parent 2 0 R",
    `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`,
    `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >>`,
    `/Contents ${contentId} 0 R`,
    ">>",
  ].join(" "));
}

function coverPageContent({
  title,
  createdLabel,
  pageNumber,
  pageCount,
}: {
  title: string;
  createdLabel: string;
  pageNumber: number;
  pageCount: number;
}): string {
  const ops = [
    "q",
    `${DARK_RGB} rg 0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT} re f`,
    `${ACCENT_RGB} rg 0 0 16 ${PAGE_HEIGHT} re f`,
    "0.118 0.118 0.137 rg 36 414 540 250 re f",
    `${ACCENT_RGB} rg 54 642 104 3 re f`,
    "Q",
  ];

  drawTextBlock(ops, {
    text: "Atlas for Undeniable",
    x: MARGIN_X,
    y: 696,
    size: 11,
    font: "F2",
    color: LIGHT_RGB,
  });
  drawTextBlock(ops, {
    text: "Undeniable OS",
    x: MARGIN_X,
    y: 672,
    size: 16,
    font: "F2",
    color: ACCENT_RGB,
  });

  let y = 594;
  for (const line of wrapPdfText(title, 34)) {
    drawTextBlock(ops, {
      text: line,
      x: MARGIN_X,
      y,
      size: 28,
      font: "F2",
      color: LIGHT_RGB,
    });
    y -= 34;
  }

  drawTextBlock(ops, {
    text: "Local draft v1",
    x: MARGIN_X,
    y: 392,
    size: 12,
    font: "F2",
    color: ACCENT_RGB,
  });
  drawTextBlock(ops, {
    text: `Created ${createdLabel}`,
    x: MARGIN_X,
    y: 370,
    size: 11,
    font: "F1",
    color: LIGHT_RGB,
  });
  drawTextBlock(ops, {
    text: "Prepared for Workspace beta review. Local artifact only; no external delivery performed.",
    x: MARGIN_X,
    y: 338,
    size: 10,
    font: "F1",
    color: "0.760 0.760 0.780",
  });
  drawFooter(ops, pageNumber, pageCount, true);
  return ops.join("\n");
}

function bodyPageContent({
  title,
  lines,
  pageNumber,
  pageCount,
}: {
  title: string;
  lines: PdfLine[];
  pageNumber: number;
  pageCount: number;
}): string {
  const ops = [
    "q",
    "1 1 1 rg 0 0 612 792 re f",
    `${DARK_RGB} rg 0 760 612 32 re f`,
    `${ACCENT_RGB} rg 0 756 612 4 re f`,
    "Q",
  ];
  drawTextBlock(ops, {
    text: "Atlas for Undeniable",
    x: MARGIN_X,
    y: 772,
    size: 8,
    font: "F2",
    color: LIGHT_RGB,
  });
  drawTextBlock(ops, {
    text: truncatePdfText(title, 62),
    x: 230,
    y: 772,
    size: 8,
    font: "F1",
    color: "0.820 0.820 0.840",
  });

  let y = BODY_TOP;
  for (const line of lines) {
    if (line.kind === "spacer") {
      y -= line.height;
      continue;
    }
    if (line.kind === "rule") {
      ops.push(`q ${ACCENT_RGB} rg ${MARGIN_X} ${y - 2} 504 1.2 re f Q`);
      y -= 12;
      continue;
    }
    const style = textStyle(line.style);
    drawTextBlock(ops, {
      text: line.text,
      x: style.x,
      y,
      size: style.size,
      font: style.font,
      color: style.color,
    });
    y -= style.leading;
  }

  drawFooter(ops, pageNumber, pageCount, false);
  return ops.join("\n");
}

function drawTextBlock(
  ops: string[],
  {
    text,
    x,
    y,
    size,
    font,
    color,
  }: {
    text: string;
    x: number;
    y: number;
    size: number;
    font: "F1" | "F2";
    color: string;
  },
): void {
  ops.push("BT");
  ops.push(`${color} rg`);
  ops.push(`/${font} ${size} Tf`);
  ops.push(`${x} ${y} Td`);
  ops.push(`(${escapePdfString(normalizePdfText(text))}) Tj`);
  ops.push("ET");
}

function drawFooter(ops: string[], pageNumber: number, pageCount: number, dark: boolean): void {
  const color = dark ? "0.760 0.760 0.780" : MUTED_RGB;
  drawTextBlock(ops, {
    text: "Undeniable OS - local draft",
    x: MARGIN_X,
    y: 34,
    size: 8,
    font: "F1",
    color,
  });
  drawTextBlock(ops, {
    text: `Page ${pageNumber} of ${pageCount}`,
    x: 502,
    y: 34,
    size: 8,
    font: "F1",
    color,
  });
}

function markdownToBrandedPdfBlocks(markdown: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  for (const rawLine of markdown.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      blocks.push({ type: "spacer" });
      continue;
    }
    if (/^Runtime provider:/i.test(line)) continue;
    if (/^Created:/i.test(line)) continue;
    if (/^Delivery:/i.test(line)) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", text: stripInlineMarkdown(heading[1]) });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: stripInlineMarkdown(bullet[1]) });
      continue;
    }
    blocks.push({ type: "paragraph", text: stripInlineMarkdown(line) });
  }
  return compactPdfBlocks(blocks);
}

function compactPdfBlocks(blocks: PdfBlock[]): PdfBlock[] {
  const compacted: PdfBlock[] = [];
  for (const block of blocks) {
    const previous = compacted[compacted.length - 1];
    if (block.type === "spacer" && (!previous || previous.type === "spacer")) continue;
    compacted.push(block);
  }
  return compacted;
}

function layoutBodyLines(blocks: PdfBlock[]): PdfLine[] {
  const lines: PdfLine[] = [
    { kind: "text", style: "eyebrow", text: "Atlas for Undeniable / Undeniable OS" },
    { kind: "rule" },
    { kind: "spacer", height: 8 },
  ];

  for (const block of blocks) {
    if (block.type === "spacer") {
      lines.push({ kind: "spacer", height: 8 });
      continue;
    }
    if (block.type === "heading") {
      lines.push({ kind: "spacer", height: 10 });
      for (const text of wrapPdfText(block.text, 58)) {
        lines.push({ kind: "text", style: "heading", text });
      }
      lines.push({ kind: "spacer", height: 4 });
      continue;
    }
    if (block.type === "bullet") {
      for (const [index, text] of wrapPdfText(block.text, 82).entries()) {
        lines.push({ kind: "text", style: "body", text: `${index === 0 ? "- " : "  "}${text}` });
      }
      continue;
    }
    for (const text of wrapPdfText(block.text, 86)) {
      lines.push({ kind: "text", style: "body", text });
    }
  }
  return lines;
}

function paginatePdfLines(lines: PdfLine[]): PdfLine[][] {
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let used = 0;
  const maxHeight = BODY_TOP - BODY_BOTTOM;
  for (const line of lines) {
    const height = lineHeight(line);
    if (page.length && used + height > maxHeight) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(line);
    used += height;
  }
  if (page.length) pages.push(page);
  return pages.length ? pages : [[{ kind: "text", style: "body", text: "" }]];
}

function lineHeight(line: PdfLine): number {
  if (line.kind === "spacer") return line.height;
  if (line.kind === "rule") return 12;
  return textStyle(line.style).leading;
}

function textStyle(style: PdfTextStyle): { x: number; size: number; leading: number; font: "F1" | "F2"; color: string } {
  if (style === "eyebrow") return { x: MARGIN_X, size: 9, leading: 14, font: "F2", color: ACCENT_RGB };
  if (style === "coverTitle") return { x: MARGIN_X, size: 28, leading: 34, font: "F2", color: LIGHT_RGB };
  if (style === "coverMeta") return { x: MARGIN_X, size: 11, leading: 16, font: "F1", color: LIGHT_RGB };
  if (style === "heading") return { x: MARGIN_X, size: 15, leading: 19, font: "F2", color: TEXT_RGB };
  if (style === "small") return { x: MARGIN_X, size: 8, leading: 11, font: "F1", color: MUTED_RGB };
  return { x: MARGIN_X, size: 10.5, leading: 15, font: "F1", color: TEXT_RGB };
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function formatPdfDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function wrapPdfText(value: string, width: number): string[] {
  const normalized = normalizePdfText(value);
  if (!normalized.trim()) return [""];
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncatePdfText(value: string, length: number): string {
  const normalized = normalizePdfText(value);
  return normalized.length <= length ? normalized : `${normalized.slice(0, Math.max(0, length - 3))}...`;
}

function normalizePdfText(value: string): string {
  return value
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(objects: string[]): Buffer {
  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteLength = Buffer.byteLength(chunks[0], "ascii");
  objects.forEach((body, index) => {
    offsets.push(byteLength);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    byteLength += Buffer.byteLength(chunk, "ascii");
  });
  const xrefOffset = byteLength;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (let index = 1; index < offsets.length; index += 1) {
    chunks.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push([
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n"));
  return Buffer.from(chunks.join(""), "ascii");
}
