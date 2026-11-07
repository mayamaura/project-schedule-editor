// @req F-101, F-104, F-105, F-107, F-201, F-202, F-204, F-205, F-208, F-209, F-304, F-305
// タイムライン画面: 左ペイン（プロジェクトツリー。DOM）・右のタイムライン（Canvas）・詳細パネル。docs/architecture.html 12.6。
// 状態（左端の日付・ズーム・縦スクロール）は ref に持ち、変化したときだけ rAF で再描画する（React の再レンダーを避ける）。
// 編集: バー/◆のドラッグは ref + rAF でプレビューし、確定時に 1 コマンドを commit する（Undo 1 単位）。
// 全ての変更は commit(コマンド) 経由。commit は成功なら null、拒否されたら理由（文字列）を返す。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  HEADER_HEIGHT,
  addDependencyCommand,
  addEventCommand,
  addMilestoneCommand,
  addProjectCommand,
  applyCommand,
  buildDrawList,
  buildLayout,
  clampPxPerDay,
  darkTheme,
  dragCommand,
  draw,
  effectiveHeaderMode,
  fromDays,
  hitTest,
  lightTheme,
  newId,
  panX,
  placeProjectCommand,
  spanOf,
  toDays,
  validateSchedule,
  visibleRowRange,
  zoomAt,
  type Canvas2D,
  type Command,
  type DrawList,
  type Hit,
  type HeaderMode,
  type Id,
  type Schedule,
  type TimelineViewport,
} from '@domain/index';
import { t } from '../i18n';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { DetailPanel, type Sel } from './DetailPanel';

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

const DRAG_THRESHOLD_PX = 4;

type DropHint = { readonly id: Id; readonly where: 'before' | 'after' | 'inside' };
type MenuState = { readonly x: number; readonly y: number; readonly items: readonly MenuItem[] };

/** 選択の表示用の文言（スクリーンリーダにも通知する。NF-010）。実体が無ければ null。 */
function describeSelection(s: Schedule, sel: Sel | null): string | null {
  if (!sel) return null;
  if (sel.kind === 'project') {
    const p = s.projects[sel.id];
    return p ? t('timeline.selectedProject', { name: p.name }) : null;
  }
  for (const p of Object.values(s.projects)) {
    const item = sel.kind === 'event' ? p.events[sel.id] : p.milestones[sel.id];
    if (item) {
      const from = 'start' in item ? item.start : item.date;
      const to = 'end' in item ? item.end : item.date;
      return t('timeline.selected', { kind: t(sel.kind === 'event' ? 'timeline.kindEvent' : 'timeline.kindMilestone'), name: item.name, from, to });
    }
  }
  return null;
}

export function TimelineView({ schedule, docKey, commit }: { schedule: Schedule; docKey: unknown; commit: (c: Command) => string | null }) {
  const dark = usePrefersDark();
  const theme = dark ? darkTheme : lightTheme;
  const [headerMode, setHeaderMode] = useState<HeaderMode>('weekMonth');
  const [deps, setDeps] = useState<DepMode>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<Id>>(new Set());
  const [rawSel, setSelected] = useState<Sel | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [linkFrom, setLinkFrom] = useState<Id | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const [showIssues, setShowIssues] = useState(false);

  // 削除などで実体が無くなった選択は無いものとして扱う
  const selLabel = describeSelection(schedule, rawSel);
  const selected = selLabel ? rawSel : null;

  const layout = useMemo(() => buildLayout(schedule, { collapsed }), [schedule, collapsed]);
  const issues = useMemo(() => validateSchedule(schedule), [schedule]);
  const errorCount = issues.filter((i) => i.severity === 'error').length;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const view = useRef<TimelineViewport>({ leftDay: toDays(todayString()) - 30, pxPerDay: 8, width: 800, height: 400, scrollY: 0 });
  const hover = useRef<Id | null>(null);
  const dl = useRef<DrawList | null>(null);
  const pending = useRef(0);
  const shownScrollY = useRef(0);

  // 最新の入力を ref に持つ（rAF のコールバックが古い値を見ないように）
  const preview = useRef<Schedule | null>(null);
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
    // 週の値が消えるほど縮小したら年月に自動で切り替え、拡大して全部出せるようになれば年月週に戻る
    const mode = effectiveHeaderMode(L.headerMode, vp.pxPerDay);
    const t0 = performance.now();
    const list = buildDrawList(preview.current ?? L.schedule, L.layout, {
      viewport: { ...vp, width: W, height: H - HEADER_HEIGHT },
      headerMode: mode,
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
    ds['headerMode'] = mode;
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

  // 文書が差し替わったら（編集ではなく）、全体の日付範囲に合わせて表示し直す
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
    setLinkFrom(null);
    request();
    // schedule は文書の初期状態としてだけ使う（編集のたびに表示位置を戻さない）
  }, [docKey, request]);

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

  // ---- 作成・削除などの操作（全てコマンド経由） ----
  const createAt = (kind: 'event' | 'milestone', projectId: Id, day: number): void => {
    const id = newId(schedule);
    const a = { projectId, id, day, name: t(kind === 'event' ? 'edit.newEvent' : 'edit.newMilestone') };
    const cmd = kind === 'event' ? addEventCommand(schedule, a) : addMilestoneCommand(schedule, a);
    if (commit(cmd) === null) setSelected({ kind, id });
  };
  const createProject = (parentId: Id | null): void => {
    const id = newId(schedule);
    if (commit(addProjectCommand(schedule, { id, name: t('edit.newProject'), parentId })) === null) {
      setSelected({ kind: 'project', id });
      if (parentId) setCollapsed((prev) => new Set([...prev].filter((x) => x !== parentId)));
    }
  };
  const deleteSel = (s: Sel): void => {
    commit(s.kind === 'event' ? { type: 'deleteEvent', id: s.id } : s.kind === 'milestone' ? { type: 'deleteMilestone', id: s.id } : { type: 'deleteProject', id: s.id });
  };
  const toggleHeader = (): void => setHeaderMode((m) => (m === 'weekMonth' ? 'month' : 'weekMonth'));
  const goToday = (): void => {
    const v = view.current;
    view.current = { ...v, leftDay: toDays(todayString()) - v.width / 2 / v.pxPerDay + 0.5 };
    request();
  };

  const menuFor = (h: Hit): MenuItem[] => {
    if (h.kind === 'event' || h.kind === 'milestone') {
      const s: Sel = { kind: h.kind, id: h.id };
      return [
        { label: t('menu.edit'), run: () => setSelected(s) },
        { label: t('menu.addDependency'), run: () => { setSelected(s); setLinkFrom(h.id); } },
        { label: t('menu.delete'), run: () => deleteSel(s) },
      ];
    }
    if (h.kind === 'row') {
      return [
        { label: t('menu.createEvent'), run: () => createAt('event', h.projectId, h.day) },
        { label: t('menu.createMilestone'), run: () => createAt('milestone', h.projectId, h.day) },
      ];
    }
    if (h.kind === 'header') {
      return [
        { label: t('menu.goToday'), run: goToday },
        { label: t('menu.toggleHeader'), run: toggleHeader },
      ];
    }
    return [];
  };
  const openMenu = (x: number, y: number, items: MenuItem[]): void => {
    if (items.length > 0) setMenu({ x, y, items });
  };
  const closeMenu = useCallback(() => {
    setMenu(null);
    canvasRef.current?.focus(); // メニューの後もキー操作（Esc・Delete）を続けられるように
  }, []);

  // ---- ポインタ: ドラッグで編集 / 空白のドラッグでパン / クリックで選択 / ホバー ----
  const drag = useRef<{ x: number; y: number; moved: boolean; edit?: { id: Id; projectId: Id; part: 'body' | 'start' | 'end'; x0: number; cmd: Command | null } } | null>(null);
  const pointer = (e: React.PointerEvent): { x: number; y: number } => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const hitAt = (x: number, y: number): Hit | null => (dl.current ? hitTest(dl.current, latest.current.layout, view.current, x, y) : null);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    const p = pointer(e);
    const h = hitAt(p.x, p.y);
    const edit = !linkFrom && h && (h.kind === 'event' || h.kind === 'milestone') ? { id: h.id, projectId: h.projectId, part: h.kind === 'event' ? h.part : ('body' as const), x0: p.x, cmd: null } : undefined;
    drag.current = { x: p.x, y: p.y, moved: false, edit };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = pointer(e);
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      if (d.edit) {
        const delta = Math.round((p.x - d.edit.x0) / view.current.pxPerDay);
        d.edit.cmd = dragCommand(schedule, d.edit.id, d.edit.part, delta);
        const r = d.edit.cmd ? applyCommand(schedule, d.edit.cmd) : null;
        preview.current = r?.ok ? r.schedule : null;
        showTip(p.x, p.y, preview.current ?? schedule, d.edit);
        setCursor(e.currentTarget as HTMLElement, d.edit.part === 'body' ? 'grabbing' : 'ew-resize');
        request();
        return;
      }
      const v = view.current;
      view.current = { ...panX(v, p.x - d.x), scrollY: v.scrollY - (p.y - d.y), height: v.height };
      d.x = p.x;
      d.y = p.y;
      request();
      return;
    }
    const h = hitAt(p.x, p.y);
    const id = h && (h.kind === 'event' || h.kind === 'milestone') ? h.id : null;
    // 開始日・終了日を変えられる端では横向きの双方向矢印にする（F-201）
    const edge = h?.kind === 'event' && h.part !== 'body';
    setCursor(e.currentTarget as HTMLElement, linkFrom ? 'crosshair' : edge ? 'ew-resize' : id ? 'move' : 'grab');
    if (id !== hover.current) {
      hover.current = id;
      request();
    }
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current;
    drag.current = null;
    if (d?.edit && d.moved) {
      preview.current = null;
      if (tipRef.current) tipRef.current.hidden = true;
      const cmd = d.edit.cmd;
      if (cmd) commit(cmd);
      else request();
      return;
    }
    if (!d || d.moved) return;
    const p = pointer(e);
    const h = hitAt(p.x, p.y);
    const isItem = h && (h.kind === 'event' || h.kind === 'milestone');
    if (linkFrom) {
      // 依存先の指定（F-305）。拒否（循環・重複など）の理由は commit が画面に出す
      if (isItem) {
        const cmd = addDependencyCommand(schedule, { id: newId(schedule), from: linkFrom, to: h.id });
        if (cmd) commit(cmd);
        setLinkFrom(null);
      }
      return;
    }
    setSelected(isItem ? { kind: h.kind as 'event' | 'milestone', id: h.id } : null);
  };
  // ドラッグ中の変更先の表示（ドロップ前に新しい日付が分かるように。DOM を直接更新して React の再描画を避ける）
  const tipRef = useRef<HTMLDivElement>(null);
  const setCursor = (el: HTMLElement, c: string): void => {
    if (el.style.cursor !== c) el.style.cursor = c;
  };
  const showTip = (x: number, y: number, s: Schedule, edit: { id: Id; projectId: Id }): void => {
    const tip = tipRef.current;
    const proj = s.projects[edit.projectId];
    const e = proj?.events[edit.id];
    const m = proj?.milestones[edit.id];
    if (!tip || (!e && !m)) return;
    tip.textContent = e ? (e.start === e.end ? e.start : `${e.start} 〜 ${e.end}`) : m!.date;
    tip.style.left = `${Math.min(x + 14, view.current.width - 160)}px`;
    tip.style.top = `${y + 18}px`;
    tip.hidden = false;
  };
  const onPointerLeave = (): void => {
    if (hover.current !== null) {
      hover.current = null;
      request();
    }
  };
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const h = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (!h) return;
    if (h.kind === 'event' || h.kind === 'milestone') setSelected({ kind: h.kind, id: h.id });
    openMenu(e.clientX, e.clientY, menuFor(h));
  };
  // キーボード: メニューキー / Shift+F10 で選択項目のメニュー、Delete で削除、Esc で依存の指定を中止（F-209）
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') setLinkFrom(null);
    else if (e.key === 'Delete' && selected) deleteSel(selected);
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && selected && selected.kind !== 'project') {
      const box = dl.current?.hitBoxes.find((b) => b.id === selected.id);
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (box) openMenu(r.left + box.x, r.top + HEADER_HEIGHT + box.y + box.h, menuFor({ kind: selected.kind, id: selected.id, projectId: box.projectId, part: 'body' }));
    } else return;
    e.preventDefault();
  };

  // ツールバー
  const zoomBy = (factor: number): void => {
    const v = view.current;
    view.current = { ...v, ...zoomAt(v, factor, v.width / 2) };
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

  // ---- 左ペインのドラッグ&ドロップ（並べ替え・親子付け替え。F-205）----
  const dragging = useRef<Id | null>(null);
  const zoneOf = (e: React.DragEvent): DropHint['where'] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'inside';
  };
  const treeMenu = (projectId: Id): MenuItem[] => [
    { label: t('menu.edit'), run: () => setSelected({ kind: 'project', id: projectId }) },
    { label: t('menu.addChild'), run: () => createProject(projectId) },
    { label: t('menu.addSibling'), run: () => createProject(schedule.projects[projectId]?.parentId ?? null) },
    { label: t('menu.delete'), run: () => deleteSel({ kind: 'project', id: projectId }) },
  ];

  const [first, last] = visibleRowRange(layout, scrollY, view.current.height);
  const rows = layout.rows.slice(first, last);
  const nameOf = (id: Id): string => {
    for (const p of Object.values(schedule.projects)) {
      const x = p.events[id] ?? p.milestones[id];
      if (x) return x.name;
    }
    return id;
  };
  const statusText = linkFrom ? t('link.hint', { name: nameOf(linkFrom) }) : (selLabel ?? '');

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
            <span>{t('timeline.projects')}</span>
            <span className="spacer" />
            <button type="button" data-testid="add-project" aria-label={t('tree.addLabel')} title={t('tree.addLabel')} onClick={() => createProject(null)}>
              ＋
            </button>
          </div>
          <div className="tree-body" style={{ height: view.current.height }}>
            {rows.map((r) => (
              <div
                key={r.projectId}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-expanded={r.hasChildren ? !r.collapsed : undefined}
                aria-selected={selected?.kind === 'project' && selected.id === r.projectId}
                draggable
                className={`tree-row${selected?.kind === 'project' && selected.id === r.projectId ? ' sel' : ''}${dropHint?.id === r.projectId ? ` drop-${dropHint.where}` : ''}`}
                style={{ top: r.y - scrollY, height: r.height, paddingLeft: 6 + r.depth * 14 }}
                data-project={r.projectId}
                onClick={() => setSelected({ kind: 'project', id: r.projectId })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected({ kind: 'project', id: r.projectId });
                  openMenu(e.clientX, e.clientY, treeMenu(r.projectId));
                }}
                onDragStart={(e) => {
                  dragging.current = r.projectId;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', r.projectId);
                }}
                onDragOver={(e) => {
                  if (!dragging.current || dragging.current === r.projectId) return;
                  e.preventDefault();
                  const where = zoneOf(e);
                  setDropHint((h) => (h?.id === r.projectId && h.where === where ? h : { id: r.projectId, where }));
                }}
                onDragLeave={() => setDropHint((h) => (h?.id === r.projectId ? null : h))}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = dragging.current;
                  const where = zoneOf(e);
                  dragging.current = null;
                  setDropHint(null);
                  const cmd = id ? placeProjectCommand(schedule, id, r.projectId, where) : null;
                  if (cmd) commit(cmd);
                }}
                onDragEnd={() => {
                  dragging.current = null;
                  setDropHint(null);
                }}
              >
                {r.hasChildren ? (
                  <button
                    type="button"
                    className="twisty"
                    aria-label={t(r.collapsed ? 'timeline.expand' : 'timeline.collapse', { name: r.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.projectId);
                    }}
                  >
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
          <div className="dragtip" ref={tipRef} hidden data-testid="dragtip" />
          <canvas
            ref={canvasRef}
            data-testid="timeline-canvas"
            tabIndex={0}
            aria-label="タイムライン"
            style={{ cursor: linkFrom ? 'crosshair' : 'grab', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
          />
        </div>
        <DetailPanel schedule={schedule} sel={selected} commit={commit} />
      </div>
      {showIssues ? (
        <ul className="issuelist" data-testid="issue-list">
          {issues.length === 0 ? <li>{t('issues.none')}</li> : null}
          {issues.map((i, n) => (
            <li key={`${i.rule}-${i.target.id}-${n}`}>
              <button
                type="button"
                className={i.severity}
                onClick={() => i.target.kind !== 'dependency' && setSelected({ kind: i.target.kind, id: i.target.id })}
              >
                {i.message}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} /> : null}
      {/* Canvas はスクリーンリーダに読まれないため、選択項目を読み上げ用に通知する（NF-010） */}
      <div className="sr-only" aria-live="polite" data-testid="selection-live">
        {selLabel ?? ''}
      </div>
      <div className="statusbar" data-testid="selection-status">
        <span>{statusText}</span>
        <span className="spacer" />
        <button type="button" className={`issuebtn${errorCount > 0 ? ' err' : ''}`} data-testid="issues" aria-expanded={showIssues} onClick={() => setShowIssues((v) => !v)}>
          {t('issues.summary', { errors: String(errorCount), warnings: String(issues.length - errorCount) })}
        </button>
      </div>
    </div>
  );
}

export { fromDays };
