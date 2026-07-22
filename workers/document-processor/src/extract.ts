import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import {
  baseMime,
  extractTagContents,
  normalize,
  parserFor,
  stripRtf,
  xmlText,
} from './text-helpers.js';

/**
 * Format → plain text. This is the only heavyweight part of the worker and the
 * reason it lives outside the agent container. v1 covers the office/text family
 * (Word, Excel, PowerPoint, OpenDocument, RTF); image and scanned-PDF OCR is a
 * deliberately isolated follow-up — those formats return `unsupported` here, and
 * enabling OCR later is a single new branch (add a tesseract pass) with no change
 * to the pipeline around it.
 */

export type ExtractKind = 'text' | 'unsupported';

export interface ExtractOutcome {
  kind: ExtractKind;
  text: string;
  detail: string;
}

async function parseDocx(bytes: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return normalize(value ?? '');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  const v = value as {
    text?: string;
    result?: unknown;
    richText?: Array<{ text?: string }>;
    hyperlink?: string;
    formula?: string;
  };
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? '').join('');
  if (typeof v.text === 'string') return v.text;
  if (v.result != null) return String(v.result);
  if (typeof v.hyperlink === 'string') return v.hyperlink;
  return '';
}

async function parseXlsx(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const lines: string[] = [];
  wb.eachSheet((sheet) => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => cells.push(cellText(cell.value)));
      if (cells.some((c) => c.trim())) lines.push(cells.join('\t'));
    });
  });
  return normalize(lines.join('\n'));
}

function slideNum(name: string): number {
  return Number.parseInt(name.match(/slide(\d+)\.xml$/i)?.[1] ?? '0', 10);
}

async function parsePptx(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  const out: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name]?.async('string');
    if (!xml) continue;
    const runs = extractTagContents(xml, 'a:t').join(' ');
    if (runs.trim()) out.push(runs.trim());
  }
  return normalize(out.join('\n\n'));
}

async function parseOpenDocument(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.files['content.xml']?.async('string');
  if (!xml) return '';
  const body = xml.replace(/<office:automatic-styles>[\s\S]*?<\/office:automatic-styles>/gi, '');
  return xmlText(body);
}

export async function extractDocument(
  bytes: Buffer,
  mime: string,
  filename: string,
): Promise<ExtractOutcome> {
  const parser = parserFor(mime, filename);
  switch (parser) {
    case 'docx':
      return { kind: 'text', text: await parseDocx(bytes), detail: 'word document' };
    case 'xlsx':
      return { kind: 'text', text: await parseXlsx(bytes), detail: 'spreadsheet' };
    case 'pptx':
      return { kind: 'text', text: await parsePptx(bytes), detail: 'presentation' };
    case 'opendocument':
      return { kind: 'text', text: await parseOpenDocument(bytes), detail: 'opendocument' };
    case 'rtf':
      return { kind: 'text', text: stripRtf(bytes.toString('utf8')), detail: 'rtf' };
    default:
      return {
        kind: 'unsupported',
        text: '',
        detail: `no parser for ${baseMime(mime) || filename} (image/scanned-PDF OCR not yet enabled)`,
      };
  }
}
