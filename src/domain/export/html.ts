// @req F-607, NF-020
// 単一 HTML の組み立て（純関数）。外部通信を CSP で禁止し、データは JSON として埋め込む（HTML として解釈させない）。
// docs/architecture.html 10.2。

/** <script type="application/json"> に安全に入れられる JSON にする（"<" を \u003c に、行区切り文字も）。 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** インラインの <script> に入れる JS から、</script> で閉じられてしまう並びを避ける。 */
export function escapeScriptBody(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const VIEWER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

export interface ViewerHtmlInput {
  readonly title: string;
  /** ビューアの JS（IIFE。CSS はこの中から挿入する）。 */
  readonly js: string;
  /** スナップショットの JSON 文字列、または圧縮済みの base64。 */
  readonly payload: string;
  /** payload の形式。gzip-base64 のときは、ビューアが DecompressionStream で展開する。 */
  readonly encoding: 'json' | 'gzip-base64';
}

export function buildViewerHtml(i: ViewerHtmlInput): string {
  const data = i.encoding === 'json' ? escapeJsonForScript(i.payload) : i.payload;
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}">`,
    `<title>${escHtml(i.title)}</title>`,
    '</head><body>',
    '<div id="app"></div>',
    `<script id="snapshot" type="application/json" data-encoding="${i.encoding}">${data}</script>`,
    `<script>${escapeScriptBody(i.js)}</script>`,
    '</body></html>',
    '',
  ].join('\n');
}
