// @req F-101, F-104, F-105, F-107, F-304
// タイムライン画面: 左ペイン（プロジェクトツリー。DOM）と右のタイムライン（Canvas）。docs/architecture.html 12.6。
// 状態（左端の日付・ズーム・縦スクロール）は ref に持ち、変化したときだけ rAF で再描画する（React の再レンダーを避ける）。
// Phase 2 は閲覧専用（編集は Phase 3）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  HEADER_HEIGHT,
  buildDrawList,
  buildLayout,
  clampPxPerDay,
  darkTheme,
  draw,
  fromDays,
  hitTest,
  lightTheme,
  panX,
  spanOf,
  toDays,
  visibleRowRange,
  zoomAt,
  type Canvas2D,
  type DrawList,
  type HeaderMode,
  type Id,
  type Schedule,
  type TimelineViewport,
} from '@domain/index';
import { t } from '../i18n';

type DepMode = 'all' | 'selected' | 'none';

function todayString(): string {
  const d = new Date();
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (): void => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

interface Selected {
  readonly id: Id;
  readonly label: string;
}

const DRAG_THRESHOLD_PX = 4;

export function TimelineView({ schedule }: { schedule: Schedule }) {
  const dark = usePrefersDark();
  const theme = dark ? darkTheme : lightTheme;
  const [headerMode, setHeaderMode] = useState<HeaderMode>('weekMonth');
  const [deps, setDeps] = useState<DepMode>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<Id>>(new Set());
  const [selected, setSelected] = useState<Selected | null>(null);
  const [scrollY, setScrollY] = useState(0);

  const layout = useMemo(() => buildLayout(schedule, { collapsed }), [schedule, collapsed]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const view = useRef<TimelineViewport>({ leftDay: toDays(todayString()) - 30, pxPerDay: 8, width: 800, height: 400, scrollY: 0 });
  const hover = useRef<Id | null>(null);
  const dl = useRef<DrawList | null>(null);
  const pending = useRef(0);
  const shownScrollY = useRef(0);

  // 最新の入力を ref に持つ（rAF のコールバックが古い値を見ないように）
  const latest = useRef({ schedule, layout, headerMode, deps, theme, selected });
  latest.current = { schedule, layout, headerMode, deps, theme, selected };

  const render = useCallback((): void => {
    pending.current = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const v = view.current;
    const L = latest.current;
    // 縦スクロールの範囲を丸める
    const maxY = Math.max(0, L.layout.totalHeight - v.height);
    if (v.scrollY > maxY) view.current = { ...v, scrollY: maxY };
    if (v.scrollY < 0) view.current = { ...v, scrollY: 0 };
    const vp = view.current;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.floor(vp.width));
    const H = Math.max(1, Math.floor(vp.height + HEADER_HEIGHT));
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t0 = performance.now();
    const list = buildDrawList(L.schedule, L.layout, {
      viewport: { ...vp, width: W, height: H - HEADER_HEIGHT },
      headerMode: L.headerMode,
      today: todayString(),
      selection: L.selected ? new Set([L.selected.id]) : new Set(),
      hover: hover.current,
      dependencies: L.deps,
      theme: L.theme,
    });
    const t1 = performance.now();
    dl.current = list;
    draw(ctx as unknown as Canvas2D, list);
    const t2 = performance.now();
    // 自動テスト・診断用の状態（表示には使わない）
    const ds = canvas.dataset;
    ds['rows'] = String(list.stats.rows);
    ds['items'] = String(list.stats.items);
    ds['deps'] = String(list.stats.deps);
    ds['leftDay'] = String(vp.leftDay);
    ds['pxPerDay'] = String(vp.pxPerDay);
    ds['headerMode'] = L.headerMode;
    const probe = list.hitBoxes[0];
    ds['probe'] = probe ? `${Math.round(probe.x + probe.w / 2)},${Math.round(probe.y + probe.h / 2 + HEADER_HEIGHT)}` : '';
    ds['buildMs'] = (t1 - t0).toFixed(2);
    ds['drawMs'] = (t2 - t1).toFixed(2);
    ds['renders'] = String(Number(ds['renders'] ?? '0') + 1);
    if (vp.scrollY !== shownScrollY.current) {
      shownScrollY.current = vp.scrollY;
      setScrollY(vp.scrollY);
    }
  }, []);

  const request = useCallback((): void => {
    if (pending.current === 0) pending.current = requestAnimationFrame(render);
  }, [render]);

  // 入力が変わったら再描画
  useEffect(() => {
    request();
  }, [request, schedule, layout, headerMode, deps, theme, selected]);

  // データが変わったら、全体の日付範囲に合わせて表示し直す
  useEffect(() => {
    const span = spanOf(schedule);
    const v = view.current;
    if (span) {
      const days = span.maxDay - span.minDay + 14;
      view.current = { ...v, leftDay: span.minDay - 7, pxPerDay: clampPxPerDay(v.width / days), scrollY: 0 };
    } else {
      view.current = { ...v, leftDay: toDays(todayString()) - 30, pxPerDay: 8, scrollY: 0 };
    }
    setSelected(null);
    request();
  }, [schedule, request]);

  // 表示サイズへの追従
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const apply = (w: number, h: number): void => {
      view.current = { ...view.current, width: Math.max(100, Math.floor(w)), height: Math.max(50, Math.floor(h) - HEADER_HEIGHT) };
      request();
    };
    apply(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) apply(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [request]);

  // ホイール: Ctrl = ズーム（カーソル下の日付を固定）/ Shift = 横スクロール / それ以外 = 縦スクロール
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const v = view.current;
      if (e.ctrlKey) view.current = { ...v, ...zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.offsetX) };
      else if (e.shiftKey) view.current = { ...v, ...panX(v, -(e.deltaY || e.deltaX)) };
      else view.current = { ...panX(v, -e.deltaX), scrollY: v.scrollY + e.deltaY, height: v.height };
      request();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [request]);

  // ドラッグでパン / クリックで選択 / ホバー
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointer = (e: React.PointerEvent): { x: number; y: number } => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitAt = (x: number, y: number) => (dl.current ? hitTest(dl.current, latest.current.layout, view.current, x, y) : null);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    const p = pointer(e);
    drag.current = { x: p.x, y: p.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = pointer(e);
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      const v = view.current;
      view.current = { ...panX(v, p.x - d.x), scrollY: v.scrollY - (p.y - d.y), height: v.height };
      d.x = p.x;
      d.y = p.y;
      request();
      return;
    }
    const h = hitAt(p.x, p.y);
    const id = h && (h.kind === 'event' || h.kind === 'milestone') ? h.id : null;
    if (id !== hover.current) {
      hover.current = id;
      (e.currentTarget as HTMLElement).style.cursor = id ? 'pointer' : 'grab';
      request();
    }
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const p = pointer(e);
    const h = hitAt(p.x, p.y);
    if (h && (h.kind === 'event' || h.kind === 'milestone')) {
      const proj = schedule.projects[h.projectId];
      const item = h.kind === 'event' ? proj?.events[h.id] : proj?.milestones[h.id];
      if (item) {
        const from = 'start' in item ? item.start : item.date;
        const to = 'end' in item ? item.end : item.date;
        setSelected({ id: h.id, label: t('timeline.selected', { kind: t(h.kind === 'event' ? 'timeline.kindEvent' : 'timeline.kindMilestone'), name: item.name, from, to }) });
        return;
      }
    }
    setSelected(null);
  };
  const onPointerLeave = (): void => {
    if (hover.current !== null) {
      hover.current = null;
      request();
    }
  };

  // ツールバー
  const zoomBy = (factor: number): void => {
    const v = view.current;
    view.current = { ...v, ...zoomAt(v, factor, v.width / 2) };
    request();
  };
  const goToday = (): void => {
    const v = view.current;
    view.current = { ...v, leftDay: toDays(todayString()) - v.width / 2 / v.pxPerDay + 0.5 };
    request();
  };
  const toggle = (id: Id): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [first, last] = visibleRowRange(layout, scrollY, view.current.height);
  const rows = layout.rows.slice(first, last);

  return (
    <div className="timeline">
      <div className="toolbar" role="toolbar" aria-label="タイムライン">
        <div className="seg" role="group" aria-label="日付ヘッダ">
          <button type="button" aria-pressed={headerMode === 'weekMonth'} data-testid="mode-week" onClick={() => setHeaderMode('weekMonth')}>
            {t('timeline.modeWeek')}
          </button>
          <button type="button" aria-pressed={headerMode === 'month'} data-testid="mode-month" onClick={() => setHeaderMode('month')}>
            {t('timeline.modeMonth')}
          </button>
        </div>
        <button type="button" data-testid="zoom-out" aria-label={t('timeline.zoomOut')} onClick={() => zoomBy(1 / 1.5)}>
          −
        </button>
        <button type="button" data-testid="zoom-in" aria-label={t('timeline.zoomIn')} onClick={() => zoomBy(1.5)}>
          ＋
        </button>
        <button type="button" data-testid="today" onClick={goToday}>
          {t('timeline.today')}
        </button>
        <label>
          {t('timeline.deps')}{' '}
          <select value={deps} data-testid="deps" onChange={(e) => setDeps(e.target.value as DepMode)}>
            <option value="all">{t('timeline.depsAll')}</option>
            <option value="selected">{t('timeline.depsSelected')}</option>
            <option value="none">{t('timeline.depsNone')}</option>
          </select>
        </label>
      </div>
      <div className="panes">
        <div className="tree" role="tree" aria-label={t('timeline.projects')}>
          <div className="tree-head" style={{ height: HEADER_HEIGHT }}>
            {t('timeline.projects')}
          </div>
          <div className="tree-body" style={{ height: view.current.height }}>
            {rows.map((r) => (
              <div key={r.projectId} role="treeitem" aria-level={r.depth + 1} aria-expanded={r.hasChildren ? !r.collapsed : undefined} className="tree-row" style={{ top: r.y - scrollY, height: r.height, paddingLeft: 6 + r.depth * 14 }} data-project={r.projectId}>
                {r.hasChildren ? (
                  <button type="button" className="twisty" aria-label={t(r.collapsed ? 'timeline.expand' : 'timeline.collapse', { name: r.name })} onClick={() => toggle(r.projectId)}>
                    {r.collapsed ? '▶' : '▼'}
                  </button>
                ) : (
                  <span className="twisty" aria-hidden="true" />
                )}
                <span className="name" title={r.name}>
                  {r.name}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="canvas-area" ref={areaRef}>
          <canvas
            ref={canvasRef}
            data-testid="timeline-canvas"
            tabIndex={0}
            aria-label="タイムライン"
            style={{ cursor: 'grab', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
          />
        </div>
      </div>
      {/* Canvas はスクリーンリーダに読まれないため、選択項目を読み上げ用に通知する（NF-010） */}
      <div className="sr-only" aria-live="polite" data-testid="selection-live">
        {selected?.label ?? ''}
      </div>
      <div className="statusbar" data-testid="selection-status">
        {selected?.label ?? ''}
      </div>
    </div>
  );
}

export { fromDays };
