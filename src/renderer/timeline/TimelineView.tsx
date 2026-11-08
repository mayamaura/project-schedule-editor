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
  nonWorkingDayFn,
  impactOf,
  filterOptions,
  copyItems,
  deleteItemsCommand,
  neighborItem,
  pasteCommand,
  shiftCommand,
  type ClipItem,
  type Layout,
  type NavDir,
  filterSchedule,
  isFilterActive,
  type SavedView,
  type ViewFilter,
  type Calendar,
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
import type { TimelineApi } from '../ExportDialog';
import { FilterBar } from '../FilterBar';
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

/** 何も選んでいないときの矢印キーで選ぶ、最初の項目（表示順で先頭の行の、開始日が最も早い項目）。 */
function firstItemId(s: Schedule, layout: Layout): Id | null {
  for (const row of layout.rows) {
    const p = s.projects[row.projectId];
    if (!p) continue;
    const all = [...Object.entries(p.events).map(([id, e]) => [id, e.start] as const), ...Object.entries(p.milestones).map(([id, m]) => [id, m.date] as const)];
    if (all.length > 0) return all.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))[0]![0];
  }
  return null;
}

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

export function TimelineView({ schedule, docKey, commit, onExpand, onSaveAsTemplate, calendar, apiRef, views = [], onSaveView, onDeleteView, canShareViews = false }: { schedule: Schedule; docKey: unknown; commit: (c: Command) => string | null; onExpand?: (target: { projectId: Id; date?: string }) => void; onSaveAsTemplate?: (projectId: Id) => void; calendar?: Calendar; apiRef?: React.MutableRefObject<TimelineApi | null>; views?: readonly SavedView[]; onSaveView?: (v: SavedView) => Promise<string | null>; onDeleteView?: (v: SavedView) => void; canShareViews?: boolean }) {
  const dark = usePrefersDark();
  const theme = dark ? darkTheme : lightTheme;
  const [headerMode, setHeaderMode] = useState<HeaderMode>('weekMonth');
  const [deps, setDeps] = useState<DepMode>('all');
  const [showImpact, setShowImpact] = useState(false); // 選択項目の上流・下流を強調する（F-306）
  const [multi, setMulti] = useState<ReadonlySet<Id>>(new Set()); // 主の選択に加えて選んだ項目（Ctrl / Shift + クリック。F-207）
  const clip = useRef<ClipItem[]>([]); // コピーした項目（F-203）
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftDays, setShiftDays] = useState('7');
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

  // 表示フィルタ（F-402）。日程は変えず、表示用の絞り込んだコピーを描く（ID は同じなので、選択・編集は元の日程に対して行える）
  const [filter, setFilter] = useState<ViewFilter>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const shown = useMemo(() => filterSchedule(schedule, filter), [schedule, filter]);
  const layout = useMemo(() => buildLayout(shown, { collapsed }), [shown, collapsed]);
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
  // 出力ダイアログへ、表示中の期間・選択中のプロジェクト・ヘッダ形式を渡す（F-601, F-608）
  if (apiRef) {
    apiRef.current = {
      visibleRange: () => {
        const v = view.current;
        return { from: fromDays(Math.floor(v.leftDay)), to: fromDays(Math.ceil(v.leftDay + v.width / v.pxPerDay)) };
      },
      selectedProjectId: () => {
        if (!selected) return null;
        if (selected.kind === 'project') return selected.id;
        for (const p of Object.values(schedule.projects)) if (p.events[selected.id] || p.milestones[selected.id]) return p.id;
        return null;
      },
      headerMode: () => headerMode,
      jumpTo: (id) => {
        const L = latest.current;
        let found: { kind: 'event' | 'milestone' | 'project'; day: number | null } | null = null;
        for (const p of Object.values(L.schedule.projects)) {
          if (p.id === id) found = { kind: 'project', day: null };
          const e = p.events[id];
          if (e) found = { kind: 'event', day: toDays(e.start) };
          const m = p.milestones[id];
          if (m) found = { kind: 'milestone', day: toDays(m.date) };
        }
        if (!found) return;
        setSelected({ kind: found.kind, id });
        const row = found.kind === 'project' ? L.layout.rowOfProject.get(id) : L.layout.itemPos.get(id)?.row;
        const r = row === undefined ? undefined : L.layout.rows[row];
        const v = view.current;
        view.current = { ...v, ...(found.day !== null ? { leftDay: found.day - v.width / 3 / v.pxPerDay } : {}), ...(r ? { scrollY: Math.max(0, r.y - v.height / 3) } : {}) };
        request();
      },
    };
  }
  const nonWorking = useMemo(() => (calendar ? nonWorkingDayFn(calendar) : undefined), [calendar]);
  const emphasis = useMemo(() => (showImpact && selected && selected.kind !== 'project' ? impactOf(schedule, selected.id) : undefined), [showImpact, selected, schedule]);
  const latest = useRef({ schedule: shown, layout, headerMode, deps, theme, selected, nonWorking, emphasis, multi });
  latest.current = { schedule: shown, layout, headerMode, deps, theme, selected, nonWorking, emphasis, multi };

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
      selection: new Set([...(L.selected ? [L.selected.id] : []), ...L.multi]),
      hover: hover.current,
      dependencies: L.deps,
      theme: L.theme,
      ...(L.nonWorking ? { nonWorkingDay: L.nonWorking } : {}),
      ...(L.emphasis ? { emphasis: L.emphasis } : {}),
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
  }, [request, shown, layout, headerMode, deps, theme, selected, nonWorking, emphasis, multi]);

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
      const ms = h.kind === 'milestone' ? schedule.projects[h.projectId]?.milestones[h.id] : undefined;
      return [
        { label: t('menu.edit'), run: () => setSelected(s) },
        { label: t('menu.addDependency'), run: () => { setSelected(s); setLinkFrom(h.id); } },
        ...(ms && onExpand ? [{ label: t('menu.expandTemplateFromMilestone'), run: () => onExpand({ projectId: h.projectId, date: ms.date }) }] : []),
        ...(selectionIds().length > 1 ? [{ label: t('menu.shiftSelected', { n: String(selectionIds().length) }), run: () => setShiftOpen(true) }] : []),
        { label: t('menu.copy'), run: () => { clip.current = copyItems(schedule, selectionIds().length > 0 ? selectionIds() : [h.id]); } },
        { label: t('menu.delete'), run: () => deleteSel(s) },
      ];
    }
    if (h.kind === 'row') {
      return [
        { label: t('menu.createEvent'), run: () => createAt('event', h.projectId, h.day) },
        { label: t('menu.createMilestone'), run: () => createAt('milestone', h.projectId, h.day) },
        ...(clip.current.length > 0 ? [{ label: t('menu.paste'), run: () => { const r = pasteCommand(schedule, clip.current, h.projectId); if (r) commit(r.command); } }] : []),
        ...(onExpand ? [{ label: t('menu.expandTemplateHere'), run: () => onExpand({ projectId: h.projectId, date: fromDays(h.day) }) }] : []),
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
    if (isItem && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      // Ctrl / Shift + クリック: 選択に加える・外す（F-207）
      setMulti((prev) => {
        const n = new Set(prev);
        if (selected && selected.kind !== 'project') n.add(selected.id);
        if (n.has(h.id)) n.delete(h.id);
        else n.add(h.id);
        return n;
      });
      setSelected({ kind: h.kind as 'event' | 'milestone', id: h.id });
      return;
    }
    setMulti(new Set());
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
  /** 選択している項目（主の選択 + 追加で選んだもの。プロジェクトを選んでいればそれも）。 */
  const selectionIds = (): Id[] => [...new Set([...(selected ? [selected.id] : []), ...multi])];
  /** コピーした項目を、選択中のプロジェクト（項目を選んでいればその項目のプロジェクト）へ貼り付ける（F-203）。 */
  const pasteSelection = (): void => {
    let pid: Id | null = null;
    if (selected?.kind === 'project') pid = selected.id;
    else if (selected) for (const p of Object.values(schedule.projects)) if (p.events[selected.id] || p.milestones[selected.id]) pid = p.id;
    pid ??= layout.rows[0]?.projectId ?? null;
    const r = pid ? pasteCommand(schedule, clip.current, pid) : null;
    if (!r || commit(r.command) !== null) return;
    setMulti(new Set(r.ids.slice(1)));
    const first = r.ids[0];
    if (first) setSelected({ kind: clip.current[0]?.kind ?? 'event', id: first });
  };
  /** 項目が画面の外にあれば、見える位置へ動かす（矢印キーでの移動）。 */
  const reveal = (id: Id): void => {
    const L = latest.current;
    const pos = L.layout.itemPos.get(id);
    const row = pos ? L.layout.rows[pos.row] : undefined;
    let day: number | null = null;
    for (const p of Object.values(L.schedule.projects)) {
      const e = p.events[id];
      const m = p.milestones[id];
      if (e) day = toDays(e.start);
      if (m) day = toDays(m.date);
    }
    const v = view.current;
    let next = v;
    if (day !== null && (day < v.leftDay || day > v.leftDay + v.width / v.pxPerDay - 2)) next = { ...next, leftDay: day - v.width / 4 / v.pxPerDay };
    if (row && (row.y < v.scrollY || row.y + row.height > v.scrollY + v.height)) next = { ...next, scrollY: Math.max(0, row.y - v.height / 3) };
    if (next !== v) {
      view.current = next;
      request();
    }
  };

  // キーボード: メニューキー / Shift+F10 で選択項目のメニュー、Delete で削除、Esc で依存の指定を中止（F-209）
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const sel = selectionIds();
    const itemKind = (id: Id): 'event' | 'milestone' | null => {
      for (const p of Object.values(schedule.projects)) {
        if (p.events[id]) return 'event';
        if (p.milestones[id]) return 'milestone';
      }
      return null;
    };
    const arrow: Record<string, NavDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    const mod = e.ctrlKey || e.metaKey;
    if (arrow[e.key] && !mod && !(e.target as HTMLElement).closest('input,textarea,select')) {
      e.preventDefault();
      if (e.altKey) {
        // Alt + ←/→: 選択した項目を 1 日ずらす（Shift で 7 日。F-207）
        const dir = arrow[e.key]!;
        if ((dir === 'left' || dir === 'right') && sel.length > 0) {
          const cmd = shiftCommand(schedule, sel, (e.shiftKey ? 7 : 1) * (dir === 'left' ? -1 : 1));
          if (cmd) commit(cmd);
        }
        return;
      }
      // 矢印キーで、選択を隣の項目へ（F-203）
      const base = selected && selected.kind !== 'project' ? selected.id : null;
      const next = base ? neighborItem(shown, layout, base, arrow[e.key]!) : firstItemId(shown, layout);
      const k = next ? itemKind(next) : null;
      if (next && k) {
        setMulti(new Set());
        setSelected({ kind: k, id: next });
        reveal(next);
      }
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X') && sel.length > 0) {
      e.preventDefault();
      clip.current = copyItems(schedule, sel);
      if (e.key.toLowerCase() === 'x') {
        const del = deleteItemsCommand(schedule, sel);
        if (del) commit(del);
      }
      return;
    }
    if (mod && (e.key === 'v' || e.key === 'V') && clip.current.length > 0) {
      e.preventDefault();
      pasteSelection();
      return;
    }
    if (e.key === 'Escape') {
      setLinkFrom(null);
      setMulti(new Set());
    } else if (e.key === 'Delete' && multi.size > 0) {
      const del = deleteItemsCommand(schedule, sel);
      if (del && commit(del) === null) setMulti(new Set());
    } else if (e.key === 'Delete' && selected) deleteSel(selected);
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
    ...(onExpand ? [{ label: t('menu.expandTemplate'), run: () => onExpand({ projectId }) }] : []),
    ...(onSaveAsTemplate ? [{ label: t('menu.saveAsTemplate'), run: () => onSaveAsTemplate(projectId) }] : []),
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
        <button type="button" data-testid="filter-toggle" aria-pressed={filterOpen || isFilterActive(filter)} onClick={() => setFilterOpen((v) => !v)}>
          {isFilterActive(filter) ? t('flt.openActive') : t('flt.open')}
        </button>
        <button type="button" data-testid="impact" aria-pressed={showImpact} disabled={!selected || selected.kind === 'project'} title={t('timeline.impactHint')} onClick={() => setShowImpact((v) => !v)}>
          {t('timeline.impact')}
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
      {filterOpen ? (
        <FilterBar
          filter={filter}
          onFilter={setFilter}
          options={filterOptions(schedule)}
          views={views}
          canShare={canShareViews}
          onApplyView={(v) => {
            setFilter(v.filter);
            setHeaderMode(v.headerMode);
            setDeps(v.dependencies);
            setCollapsed(new Set(v.collapsed));
          }}
          onSaveView={async (name, shared) => {
            if (!onSaveView) return null;
            return onSaveView({ id: `v-${Math.random().toString(36).slice(2, 10)}`, name, shared, filter, headerMode, dependencies: deps, collapsed: [...collapsed] });
          }}
          onDeleteView={(v) => onDeleteView?.(v)}
        />
      ) : null}
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
      {shiftOpen ? (
        <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && setShiftOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" data-testid="dialog-shift">
            <h2>{t('shift.title', { n: String(selectionIds().length) })}</h2>
            <label className="field">
              <span>{t('shift.days')}</span>
              <input type="number" data-testid="shift-days" value={shiftDays} onChange={(e) => setShiftDays(e.target.value)} autoFocus />
            </label>
            <p className="hint">{t('shift.hint')}</p>
            <div className="actions">
              <button
                type="button"
                data-testid="shift-go"
                onClick={() => {
                  const cmd = shiftCommand(schedule, selectionIds(), Math.trunc(Number(shiftDays) || 0));
                  setShiftOpen(false);
                  if (cmd) commit(cmd);
                }}
              >
                {t('shift.go')}
              </button>
              <button type="button" onClick={() => setShiftOpen(false)}>
                {t('sync.cancel')}
              </button>
            </div>
          </div>
        </div>
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
