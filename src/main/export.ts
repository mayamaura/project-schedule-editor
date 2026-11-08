// @req F-601, F-606, F-607, NF-020
// 出力ファイルの生成（Main）。HTML ビューアの組み立て、SVG / PNG の保存、PDF（Chromium の printToPDF）。
// 組み立ての規則（CSP・エスケープ）は domain/export/html.ts。ここはファイル・ウィンドウの扱いだけ。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BrowserWindow } from 'electron';
import { buildViewerHtml } from '../domain/export/html';

/** データがこれを超えたら gzip + base64 にして埋め込む（NF-020 のサイズ目標）。 */
export const COMPRESS_OVER = 1_500_000;

export function viewerJs(): string {
  return readFileSync(join(__dirname, '../viewer/viewer.js'), 'utf8');
}

export function buildHtmlFile(snapshotJson: string, title: string, js: string = viewerJs()): { html: string; compressed: boolean } {
  const compressed = snapshotJson.length > COMPRESS_OVER;
  const html = buildViewerHtml({
    title,
    js,
    payload: compressed ? gzipSync(Buffer.from(snapshotJson, 'utf8'), { level: 9 }).toString('base64') : snapshotJson,
    encoding: compressed ? 'gzip-base64' : 'json',
  });
  return { html, compressed };
}

const PAPER_MM: Readonly<Record<'A4' | 'A3', readonly [number, number]>> = { A4: [210, 297], A3: [297, 420] };
const MARGIN_MM = 8;

/** SVG を 1 ページに収めた、ベクタ・フォント埋め込み・文字選択可の PDF にする（Chromium の PDF 出力）。 */
export async function renderPdf(svg: string, paper: 'A4' | 'A3', landscape: boolean): Promise<Buffer> {
  const [pw, ph] = PAPER_MM[paper];
  const [w, h] = landscape ? [ph, pw] : [pw, ph];
  const cw = w - MARGIN_MM * 2;
  const ch = h - MARGIN_MM * 2;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>@page{size:${paper} ${landscape ? 'landscape' : 'portrait'};margin:${MARGIN_MM}mm}html,body{margin:0;padding:0}svg{display:block;width:${cw}mm;height:${ch}mm}</style></head><body>${svg}</body></html>`;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ pageSize: paper, landscape, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: true });
  } finally {
    win.destroy();
  }
}
