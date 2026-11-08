// @req F-607, NF-020
// 閲覧専用ビューア（出力する単一 HTML に埋め込む）。React 非依存。src/domain の描画コード（buildDrawList / draw /
// ヒットテスト / ズーム・ヘッダ）を共有する。編集・Git・AI・外部通信は持たない。docs/architecture.html 10.2。
// データは JSON として埋め込まれ、表示は fillText / textContent のみ（HTML として解釈しない）。
import { nonWorkingDayFn } from '../domain/calendar';
import { toDays } from '../domain/date';
import { scheduleFromSnapshot, type Snapshot } from '../domain/export/snapshot';
import type { Id, Schedule } from '../domain/model';
import { clampPxPerDay, effectiveHeaderMode, panX, zoomAt, type HeaderMode } from '../domain/timeline/axis';
import { draw, type Canvas2D } from '../domain/timeline/draw';
import { buildDrawList, darkTheme, HEADER_HEIGHT, lightTheme, type DrawList, type TimelineViewport } from '../domain/timeline/drawlist';
import { hitTest } from '../domain/timeline/hittest';
import { buildLayout, type Layout } from '../domain/timeline/layout';

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2933;--line:#cbd2d9;--bar:#f5f7fa;--accent:#2364aa}
@media (prefers-color-scheme:dark){:root{--bg:#161b22;--fg:#e4e7eb;--line:#3a4552;--bar:#1f252d;--accent:#6ea8e6}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:13px "Yu Gothic UI","Meiryo",system-ui,sans-serif}
#app{display:flex;flex-direction:column;height:100%}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 10px;background:var(--bar);border-bottom:1px solid var(--line)}
.bar h1{font-size:14px;margin:0 8px 0 0}
.bar button,.bar select{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:3px 8px;cursor:pointer}
.bar button[aria-pressed="true"]{background:var(--accent);color:#fff;border-color:var(--accent)}
.main{flex:1;display:flex;min-height:0}
.tree{flex:0 0 220px;overflow:hidden;position:relative;border-right:1px solid var(--line)}
.tree .head{height:${HEADER_HEIGHT}px;background:var(--bar);border-bottom:1px solid var(--line);padding:4px 8px;font-weight:bold}
.tree .rows{position:relative}
.tree .row{position:absolute;left:0;right:0;display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden}
.tree .row button{border:0;background:none;color:inherit;cursor:pointer;width:16px;padding:0}
.tree .row .spacer{display:inline-block;width:16px}
.wrap{flex:1;position:relative;min-width:0}
canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}
.tip{position:fixed;z-index:5;max-width:320px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,.25);pointer-events:none;white-space:pre-wrap}
.foot{padding:4px 10px;border-top:1px solid var(--line);background:var(--bar);font-size:12px;opacity:.85}
@media print{.bar,.foot .notice{display:none}.tree{flex-basis:180px}}
`;

const DAY_MS = 86400000;
const todayDay = (): number => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / DAY_MS);

async function readSnapshot(): Promise<unknown> {
  const el = document.getElementById('snapshot');
  if (!el) throw new Error('データがありません');
  const text = el.textContent ?? '';
  if (el.getAttribute('data-encoding') !== 'gzip-base64') return JSON.parse(text);
  const bin = atob(text.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function fail(app: HTMLElement, message: string): void {
  app.textContent = message;
}

function start(app: HTMLElement, schedule: Schedule, snap: Snapshot): void {
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.title = snap.title || document.title;

  // ---- 画面の骨組み（文字は textContent のみ）----
  const bar = el('div', { class: 'bar', role: 'toolbar' });
  bar.appendChild(el('h1', {}, snap.title || '日程'));
  const modeWeek = el('button', { type: 'button', 'data-testid': 'v-week' }, '年月週');
  const modeMonth = el('button', { type: 'button', 'data-testid': 'v-month' }, '年月');
  const zoomOut = el('button', { type: 'button', 'aria-label': '縮小', 'data-testid': 'v-zoom-out' }, '−');
  const zoomIn = el('button', { type: 'button', 'aria-label': '拡大', 'data-testid': 'v-zoom-in' }, '＋');
  const todayBtn = el('button', { type: 'button', 'data-testid': 'v-today' }, '今日');
  bar.append(modeWeek, modeMonth, zoomOut, zoomIn, todayBtn);
  const depSelect = el('select', { 'aria-label': '依存線', 'data-testid': 'v-deps' });
  for (const [v, label] of [['all', '依存線: すべて'], ['selected', '依存線: 選択項目のみ'], ['none', '依存線: 非表示']] as const) depSelect.appendChild(el('option', { value: v }, label));
  if (snap.options.dependencies && Object.keys(snap.dependencies).length > 0) bar.appendChild(depSelect);

  const main = el('div', { class: 'main' });
  const tree = el('div', { class: 'tree', 'data-testid': 'v-tree' });
  tree.appendChild(el('div', { class: 'head' }, 'プロジェクト'));
  const rowsEl = el('div', { class: 'rows' });
  tree.appendChild(rowsEl);
  const wrap = el('div', { class: 'wrap' });
  const canvas = el('canvas', { tabindex: '0', role: 'img', 'aria-label': '日程のタイムライン（閲覧専用）', 'data-testid': 'v-canvas' });
  wrap.appendChild(canvas);
  main.append(tree, wrap);
  const foot = el('div', { class: 'foot' });
  foot.appendChild(el('span', {}, `${snap.source.label}　出力: ${snap.generatedAt}　`));
  foot.appendChild(el('span', { class: 'notice' }, 'このファイルは暗号化されていません。含まれる日程は全て読めます。閲覧専用です。'));
  const tip = el('div', { class: 'tip', role: 'tooltip' });
  tip.hidden = true;
  app.append(bar, main, foot, tip);

  // ---- 状態 ----
  let collapsed = new Set<Id>();
  let layout: Layout = buildLayout(schedule, { collapsed });
  let headerMode: HeaderMode = snap.options.headerMode;
  let depMode: 'all' | 'selected' | 'none' = snap.options.dependencies ? 'all' : 'none';
  let selected: Id | null = null;
  let hover: Id | null = null;
  let dl: DrawList | null = null;
  let view: TimelineViewport = { leftDay: todayDay() - 30, pxPerDay: 8, width: 800, height: 400, scrollY: 0 };
  const nonWorking = nonWorkingDayFn(snap.calendar);
  let raf = 0;
  const request = (): void => {
    if (raf === 0) raf = requestAnimationFrame(render);
  };

  const dark = window.matchMedia('(prefers-color-scheme: dark)');

  function fit(): void {
    if (!snap.range) return;
    const a = toDays(snap.range.from) - 7;
    const b = toDays(snap.range.to) + 8;
    const px = clampPxPerDay(view.width / (b - a));
    view = { ...view, leftDay: a, pxPerDay: px };
  }

  function rebuildTree(): void {
    rowsEl.replaceChildren();
    rowsEl.style.height = `${layout.totalHeight}px`;
    for (const r of layout.rows) {
      const row = el('div', { class: 'row', 'data-testid': 'v-row' });
      row.style.top = `${r.y}px`;
      row.style.height = `${r.height}px`;
      row.style.paddingLeft = `${6 + r.depth * 14}px`;
      if (r.hasChildren) {
        const b = el('button', { type: 'button', 'aria-label': `${r.name} を${r.collapsed ? '展開' : '折りたたみ'}`, 'aria-expanded': String(!r.collapsed) }, r.collapsed ? '▶' : '▼');
        b.addEventListener('click', () => {
          const next = new Set(collapsed);
          if (next.has(r.projectId)) next.delete(r.projectId);
          else next.add(r.projectId);
          collapsed = next;
          layout = buildLayout(schedule, { collapsed });
          rebuildTree();
          request();
        });
        row.appendChild(b);
      } else row.appendChild(el('span', { class: 'spacer' }));
      row.appendChild(el('span', {}, r.name));
      rowsEl.appendChild(row);
    }
  }

  function render(): void {
    raf = 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = Math.max(1, Math.floor(wrap.clientWidth));
    const H = Math.max(1, Math.floor(wrap.clientHeight));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const bodyH = Math.max(1, H - HEADER_HEIGHT);
    const maxY = Math.max(0, layout.totalHeight - bodyH);
    view = { ...view, width: W, height: bodyH, scrollY: Math.min(maxY, Math.max(0, view.scrollY)), pxPerDay: clampPxPerDay(view.pxPerDay) };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mode = effectiveHeaderMode(headerMode, view.pxPerDay);
    dl = buildDrawList(schedule, layout, {
      viewport: view,
      headerMode: mode,
      today: new Date(todayDay() * DAY_MS).toISOString().slice(0, 10),
      selection: selected ? new Set([selected]) : new Set(),
      hover,
      dependencies: depMode,
      theme: dark.matches ? darkTheme : lightTheme,
      nonWorkingDay: nonWorking,
    });
    draw(ctx as unknown as Canvas2D, dl);
    rowsEl.style.transform = `translateY(${-view.scrollY}px)`;
    modeWeek.setAttribute('aria-pressed', String(headerMode === 'weekMonth'));
    modeMonth.setAttribute('aria-pressed', String(headerMode === 'month'));
    // 自動テスト・診断用の状態（表示には使わない）
    canvas.dataset['items'] = String(dl.stats.items);
    canvas.dataset['leftDay'] = String(view.leftDay);
    canvas.dataset['pxPerDay'] = String(view.pxPerDay);
    canvas.dataset['scrollY'] = String(view.scrollY);
  }

  // ---- 操作 ----
  const zoomBy = (f: number, x = view.width / 2): void => {
    view = { ...view, ...zoomAt(view, f, x) };
    request();
  };
  modeWeek.addEventListener('click', () => {
    headerMode = 'weekMonth';
    request();
  });
  modeMonth.addEventListener('click', () => {
    headerMode = 'month';
    request();
  });
  zoomIn.addEventListener('click', () => zoomBy(1.4));
  zoomOut.addEventListener('click', () => zoomBy(1 / 1.4));
  todayBtn.addEventListener('click', () => {
    view = { ...view, leftDay: todayDay() - view.width / 2 / view.pxPerDay + 0.5 };
    request();
  });
  depSelect.addEventListener('change', () => {
    depMode = depSelect.value as typeof depMode;
    request();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) view = { ...view, ...zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.offsetX) };
      else if (e.shiftKey) view = { ...view, ...panX(view, -(e.deltaY || e.deltaX)) };
      else view = { ...view, ...panX(view, -e.deltaX), scrollY: view.scrollY + e.deltaY };
      request();
    },
    { passive: false },
  );

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number } | null = null;
  let drag: { x: number; y: number; moved: boolean } | null = null;
  const itemInfo = (id: Id): string[] => {
    for (const p of Object.values(schedule.projects)) {
      const e = p.events[id];
      if (e) return [e.name, `${e.start} ～ ${e.end}`, `プロジェクト: ${p.name}`, ...(e.note ? [`メモ: ${e.note}`] : []), ...(p.assignee ? [`担当: ${p.assignee}`] : [])];
      const m = p.milestones[id];
      if (m) return [`◆ ${m.name}`, m.date, `プロジェクト: ${p.name}`, ...(m.note ? [`メモ: ${m.note}`] : []), ...(p.assignee ? [`担当: ${p.assignee}`] : [])];
    }
    return [];
  };
  const hitAt = (x: number, y: number): Id | null => {
    if (!dl) return null;
    const h = hitTest(dl, layout, view, x, y);
    return h.kind === 'event' || h.kind === 'milestone' ? h.id : null;
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null;
    } else drag = { x: e.offsetX, y: e.offsetY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.dist > 0) zoomBy(dist / pinch.dist, (a.x + b.x) / 2);
      pinch = { dist };
      return;
    }
    if (drag) {
      const dx = e.offsetX - drag.x;
      const dy = e.offsetY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        view = { ...view, ...panX(view, dx), scrollY: view.scrollY - dy };
        drag = { ...drag, x: e.offsetX, y: e.offsetY };
        tip.hidden = true;
        request();
        return;
      }
    }
    const id = hitAt(e.offsetX, e.offsetY);
    if (id !== hover) {
      hover = id;
      request();
    }
    if (id) {
      const lines = itemInfo(id);
      tip.textContent = lines.join('\n');
      tip.hidden = false;
      tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 340)}px`;
      tip.style.top = `${e.clientY + 14}px`;
    } else tip.hidden = true;
  });
  const up = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved) {
      const id = hitAt(e.offsetX, e.offsetY);
      selected = id === selected ? null : id;
      request();
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    tip.hidden = true;
    request();
  });
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') view = { ...view, ...panX(view, 60) };
    else if (k === 'ArrowRight') view = { ...view, ...panX(view, -60) };
    else if (k === 'ArrowUp') view = { ...view, scrollY: view.scrollY - 40 };
    else if (k === 'ArrowDown') view = { ...view, scrollY: view.scrollY + 40 };
    else if (k === '+' || k === '=') zoomBy(1.4);
    else if (k === '-') zoomBy(1 / 1.4);
    else if (k === 'Home') fit();
    else if (k === 'End') view = { ...view, scrollY: layout.totalHeight };
    else return;
    e.preventDefault();
    request();
  });
  new ResizeObserver(request).observe(wrap);
  dark.addEventListener('change', request);

  rebuildTree();
  view = { ...view, width: wrap.clientWidth || 800 };
  fit();
  request();
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  try {
    const parsed = scheduleFromSnapshot(await readSnapshot());
    if (!parsed) return fail(app, 'データを読み込めませんでした。');
    start(app, parsed.schedule, parsed.snapshot);
  } catch (e) {
    fail(app, `表示できませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
}
void main();
