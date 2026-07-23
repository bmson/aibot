import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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

const run = promisify(execFile);

/**
 * Format → plain text. This is the only heavyweight part of the worker and the
 * reason it lives outside the agent container. Covers the office/text family
 * (Word, Excel, PowerPoint, OpenDocument, RTF) plus OCR for images and scanned
 * PDFs via tesseract + poppler (installed in the worker image).
 */

const OCR_TIMEOUT_MS = 120_000;
const OCR_MAX_PDF_PAGES = 20;
const OCR_MAX_CHARS = 200_000;

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

/** OCR a single image file (any format tesseract's leptonica reads). */
async function ocrImageBytes(bytes: Buffer, ext: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ocr-'));
  try {
    const input = path.join(dir, `in.${ext}`);
    await writeFile(input, bytes);
    // `tesseract <in> stdout` prints recognized text to stdout.
    const { stdout } = await run('tesseract', [input, 'stdout'], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return normalize(stdout).slice(0, OCR_MAX_CHARS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Rasterize a scanned PDF (pdftoppm) and OCR each page (capped). */
async function parsePdfOcr(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ocr-pdf-'));
  try {
    const pdf = path.join(dir, 'in.pdf');
    await writeFile(pdf, bytes);
    // pdftoppm -png -r 200 in.pdf page → page-1.png, page-2.png, …
    await run(
      'pdftoppm',
      ['-png', '-r', '200', '-l', String(OCR_MAX_PDF_PAGES), pdf, path.join(dir, 'page')],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const pageNum = (name: string) => Number.parseInt(name.match(/\d+/)?.[0] ?? '0', 10);
    const pages = (await readdir(dir))
      .filter((n) => /^page-\d+\.png$/.test(n))
      .sort((a, b) => pageNum(a) - pageNum(b))
      .slice(0, OCR_MAX_PDF_PAGES);
    const out: string[] = [];
    for (const page of pages) {
      const { stdout } = await run('tesseract', [path.join(dir, page), 'stdout'], {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      const text = normalize(stdout);
      if (text) out.push(text);
      if (out.join('\n\n').length > OCR_MAX_CHARS) break;
    }
    return out.join('\n\n').slice(0, OCR_MAX_CHARS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function imageExt(mime: string, filename: string): string {
  const fromName = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const sub = baseMime(mime).split('/')[1];
  return sub && /^[a-z0-9]+$/.test(sub) ? sub : 'png';
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
    case 'image':
      return {
        kind: 'text',
        text: await ocrImageBytes(bytes, imageExt(mime, filename)),
        detail: 'image (ocr)',
      };
    case 'pdf':
      return { kind: 'text', text: await parsePdfOcr(bytes), detail: 'scanned pdf (ocr)' };
    default:
      return {
        kind: 'unsupported',
        text: '',
        detail: `no parser for ${baseMime(mime) || filename}`,
      };
  }
}
