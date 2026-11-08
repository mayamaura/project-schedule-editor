// @req F-801, F-809
// 標準日程のグラフィカル編集（ui-design 6.2）。横軸 = 起点（0）からの前後（ヶ月・週の目盛り）。
// バー・◆をドラッグして位置を、端をドラッグして期間を変える。位置は吸着単位（ヶ月 / 週 / 日）に丸める。
// 横軸は平均月長の目安で、実際の日付は展開時に暦で決まる。計算は domain/template.ts（ここは入力と描画だけ）。
import { useEffect, useRef, useState } from 'react';
import { dragEvent, describeOffset, MONTH_DAYS, offsetToX, shiftOffset, SNAP_DAYS, type DragPart, type Id, type Offset, type SnapUnit, type Template } from '@domain/index';
import { t } from './i18n';

export type TplSel = { readonly kind: 'event' | 'milestone'; readonly id: Id } | null;

const ROW = 28;
const HEAD = 28;
const EDGE = 6;
const MIN_BAR = 8;

interface Row {
  readonly kind: 'event' | 'milestone';
  readonly id: Id;
  readonly name: string;
  readonly start: Offset;
  readonly end: Offset;
}

interface Drag {
  readonly row: Row;
  readonly part: DragPart;
  readonly x0: number;
  readonly n: number;
}

function rowsOf(d: Template): Row[] {
  const rows: Row[] = [
    ...Object.entries(d.events).map(([id, e]) => ({ kind: 'event' as const, id, name: e.name, start: e.start, end: e.end })),
    ...Object.entries(d.milestones).map(([id, m]) => ({ kind: 'milestone' as const, id, name: m.name, start: m.date, end: m.date })),
  ];
  return rows.sort((a, b) => offsetToX(a.start) - offsetToX(b.start) || (a.name < b.name ? -1 : 1));
}

/** ドラッグ中の見た目（確定前）。 */
function previewOf(row: Row, drag: Drag | null, unit: SnapUnit): Row {
  if (!drag || drag.row.id !== row.id || drag.n === 0) return row;
  if (row.kind === 'milestone') {
    const o = shiftOffset(row.start, drag.n, unit);
    return { ...row, start: o, end: o };
  }
  return { ...row, ...dragEvent(row, drag.part, drag.n, unit) };
}

export function TemplateTimeline({ draft, selected, onSelect, onChange }: { draft: Template; selected: TplSel; onSelect: (s: TplSel) => void; onChange: (t: Template) => void }) {
  const [zoom, setZoom] = useState<number | null>(null); // 利用者が拡大縮小したときの 1 日あたりの幅(px)。null は「ウィンドウの幅に合わせる」
  const [boxW, setBoxW] = useState(0);
  const [unit, setUnit] = useState<SnapUnit>('month');
  const [drag, setDrag] = useState<Drag | null>(null);
  const frozen = useRef<{ min: number; max: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = rowsOf(draft);
  const live = rows.map((r) => previewOf(r, drag, unit));

  // 表示範囲: 項目の範囲 ± 3 ヶ月（最小 ±6 ヶ月）。ドラッグ中は動かさない（座標がずれないように）
  let range = frozen.current;
  if (!range) {
    const xs = rows.flatMap((r) => [offsetToX(r.start), offsetToX(r.end)]);
    range = { min: Math.floor(Math.min(-6 * MONTH_DAYS, ...xs.map((x) => x - 3 * MONTH_DAYS)) / MONTH_DAYS) * MONTH_DAYS, max: Math.ceil(Math.max(6 * MONTH_DAYS, ...xs.map((x) => x + 3 * MONTH_DAYS)) / MONTH_DAYS) * MONTH_DAYS };
  }
  const ppd = zoom ?? Math.max(2.4, boxW / (range.max - range.min)); // 既定は表示範囲がちょうど収まる幅
  const X = (day: number): number => (day - range.min) * ppd;
  const width = (range.max - range.min) * ppd;
  const height = HEAD + Math.max(rows.length, 1) * ROW;

  const monthStep = Math.max(1, Math.ceil(44 / (ppd * MONTH_DAYS)));
  const kMin = Math.ceil(range.min / MONTH_DAYS);
  const kMax = Math.floor(range.max / MONTH_DAYS);
  const months: number[] = [];
  for (let k = kMin; k <= kMax; k++) if (k % monthStep === 0) months.push(k);
  const weekLines: number[] = [];
  if (ppd >= 3) for (let d = Math.ceil(range.min / 7) * 7; d <= range.max; d += 7) weekLines.push(d);

  // 表示領域の幅を追う（ウィンドウを広げたら、グラフも広がる）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setBoxW(el.clientWidth);
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 最初に、起点（0）が中央に来る位置へスクロールする
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, X(0) - el.clientWidth / 2);
  }, []);

  const begin = (e: React.PointerEvent, row: Row, part: DragPart): void => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    frozen.current = range;
    onSelect({ kind: row.kind, id: row.id });
    setDrag({ row, part, x0: e.clientX, n: 0 });
  };
  const move = (e: React.PointerEvent): void => {
    if (!drag) return;
    const n = Math.round((e.clientX - drag.x0) / ppd / SNAP_DAYS[unit]);
    if (n !== drag.n) setDrag({ ...drag, n });
  };
  const end = (e: React.PointerEvent): void => {
    if (!drag) return;
    svgRef.current?.releasePointerCapture(e.pointerId);
    const r = previewOf(drag.row, drag, unit);
    if (drag.n !== 0) {
      if (r.kind === 'event') onChange({ ...draft, events: { ...draft.events, [r.id]: { ...draft.events[r.id]!, start: r.start, end: r.end } } });
      else onChange({ ...draft, milestones: { ...draft.milestones, [r.id]: { ...draft.milestones[r.id]!, date: r.start } } });
    }
    frozen.current = null;
    setDrag(null);
  };

  const dragRow = drag ? live.find((r) => r.id === drag.row.id) : null;
  const hint = dragRow ? (dragRow.kind === 'event' ? `${describeOffset(dragRow.start)} ～ ${describeOffset(dragRow.end)}` : describeOffset(dragRow.start)) : '';

  return (
    <div className="tpl-tl" data-testid="tpl-chart">
      <div className="tpl-tl-tools">
        <label>
          {t('tpl.snap')}{' '}
          <select data-testid="tpl-snap" value={unit} onChange={(e) => setUnit(e.target.value as SnapUnit)}>
            <option value="month">{t('tpl.unitMonth')}</option>
            <option value="week">{t('tpl.unitWeek')}</option>
            <option value="day">{t('tpl.unitDay')}</option>
          </select>
        </label>
        <button type="button" aria-label={t('tpl.zoomOut')} onClick={() => setZoom(Math.max(0.8, ppd / 1.5))}>
          −
        </button>
        <button type="button" aria-label={t('tpl.zoomIn')} onClick={() => setZoom(Math.min(12, ppd * 1.5))}>
          ＋
        </button>
        <span className="hint" data-testid="tpl-drag-hint" aria-live="polite">
          {hint || t('tpl.chartHelp')}
        </span>
      </div>
      <div className="tpl-tl-body">
        <div className="tpl-tl-names" style={{ paddingTop: HEAD }}>
          {rows.map((r, i) => (
            <div key={r.id} className={`tpl-tl-name${selected?.id === r.id ? ' on' : ''}`} style={{ height: ROW }} data-testid={`tpl-name-${i}`} onClick={() => onSelect({ kind: r.kind, id: r.id })}>
              {r.kind === 'event' ? '▬' : '◆'} {r.name}
            </div>
          ))}
        </div>
        <div className="tpl-tl-scroll" ref={scrollRef}>
          <svg ref={svgRef} width={width} height={height} role="img" aria-label={t('tpl.chartLabel')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={() => onSelect(null)}>
            <rect x={0} y={0} width={width} height={HEAD} className="tpl-tl-head" />
            {weekLines.map((d) => (
              <line key={`w${d}`} x1={X(d)} x2={X(d)} y1={HEAD} y2={height} className="tpl-tl-week" />
            ))}
            {months.map((k) => (
              <g key={`m${k}`}>
                <line x1={X(k * MONTH_DAYS)} x2={X(k * MONTH_DAYS)} y1={HEAD - 8} y2={height} className="tpl-tl-month" />
                <text x={X(k * MONTH_DAYS) + 3} y={HEAD - 11} className="tpl-tl-label">
                  {k === 0 ? t('tpl.anchorLabel') : `${k > 0 ? '+' : '−'}${Math.abs(k)}${t('tpl.unitMonth')}`}
                </text>
              </g>
            ))}
            <line x1={X(0)} x2={X(0)} y1={0} y2={height} className="tpl-tl-zero" data-testid="tpl-zero" />
            {live.map((r, i) => {
              const y = HEAD + i * ROW;
              const sel = selected?.id === r.id;
              if (r.kind === 'milestone') {
                const cx = X(offsetToX(r.start));
                return (
                  <polygon
                    key={r.id}
                    data-testid={`tpl-item-${i}`}
                    data-kind="milestone"
                    className={`tpl-tl-ms${sel ? ' on' : ''}`}
                    points={`${cx},${y + 5} ${cx + 9},${y + ROW / 2} ${cx},${y + ROW - 5} ${cx - 9},${y + ROW / 2}`}
                    onPointerDown={(e) => begin(e, rows[i]!, 'body')}
                  />
                );
              }
              const x1 = X(offsetToX(r.start));
              const x2 = Math.max(X(offsetToX(r.end)), x1 + MIN_BAR);
              return (
                <g key={r.id} className={`tpl-tl-ev${sel ? ' on' : ''}`} data-testid={`tpl-item-${i}`} data-kind="event">
                  <rect x={x1} y={y + 6} width={x2 - x1} height={ROW - 12} rx={3} className="tpl-tl-bar" onPointerDown={(e) => begin(e, rows[i]!, 'body')} />
                  <rect x={x1 - EDGE / 2} y={y + 4} width={EDGE} height={ROW - 8} className="tpl-tl-edge" data-testid={`tpl-edge-start-${i}`} onPointerDown={(e) => begin(e, rows[i]!, 'start')} />
                  <rect x={x2 - EDGE / 2} y={y + 4} width={EDGE} height={ROW - 8} className="tpl-tl-edge" data-testid={`tpl-edge-end-${i}`} onPointerDown={(e) => begin(e, rows[i]!, 'end')} />
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
