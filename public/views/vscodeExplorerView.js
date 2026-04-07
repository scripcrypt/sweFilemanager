import { depthOf, getDirName } from '../core/path.js';

function fmtBytes(n) {
  // バイト数を人間が読みやすい表記に変換する（B/KB/MB/...）。
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtTime(ms) {
  // epoch ms をローカル日時文字列にする。
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString();
}

function extClass(name) {
  // ファイル名から拡張子クラス（ext-xxx）を作る。
  // アイコン（CSSフォールバック）や色分け用。
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  const ext = name.slice(idx + 1).toLowerCase();
  return ext ? `ext-${ext}` : '';
}

function fileExt(name) {
  // ファイル名から拡張子文字列だけを取得する（"js" など）。
  const idx = (name ?? '').toString().lastIndexOf('.');
  if (idx <= 0) return '';
  return (name ?? '').toString().slice(idx + 1).toLowerCase();
}

function isImageFile(name) {
  // グリッド表示でサムネ表示する対象かどうか。
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return false;
  const ext = name.slice(idx + 1).toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
}

export function createVsCodeExplorerView({ store, commands }) {
  // UI（View）本体。
  // - store を購読して状態変化に応じて描画する
  // - 各 DOM イベント（click/dblclick/drag/contextmenu/keyboard）をここで束ねる
  // - 左ツリー/右ペインの選択状態や DnD 状態など、UI 固有の state を保持する
  const tbody = document.getElementById('tbody');
  const tableEl = document.getElementById('table');
  const gridEl = document.getElementById('grid');
  const breadcrumb = document.getElementById('breadcrumb');
  const statusEl = document.getElementById('status');
  const treeEl = document.getElementById('tree');
  const panelEl = document.querySelector('.swefm-panel');
  const contentEl = document.querySelector('.swefm-content');
  const appRootEl = document.querySelector('.sweFilemanager');

  const btnUp = document.getElementById('btn-up');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnMkdir = document.getElementById('btn-mkdir');
  const btnTouch = document.getElementById('btn-touch');
  const btnDelete = document.getElementById('btn-delete');
  const btnUpload = document.getElementById('btn-upload');
  const btnViewList = document.getElementById('btn-view-list');
  const btnViewIcons = document.getElementById('btn-view-icons');
  const fileUpload = document.getElementById('file-upload');
  const rootSelect = document.getElementById('root-select');

  const uploadModalEl = document.getElementById('upload-modal');
  const uploadModalBackdropEl = document.getElementById('upload-modal-backdrop');
  const btnUploadClose = document.getElementById('btn-upload-close');
  const btnUploadChoose = document.getElementById('btn-upload-choose');
  const uploadDropEl = document.getElementById('upload-drop');
  const uploadBusyEl = document.getElementById('upload-busy');
  const uploadLogEl = document.getElementById('upload-log');

  // 右ペイン: 作成/リネームのインライン入力状態
  let createDraft = null;
  let renameDraft = null;

  // 右ペイン: 選択状態（複数選択）
  let selectedPaths = new Set();
  let selectionAnchorIndex = null;
  let lastCtxX = 0;
  let lastCtxY = 0;

  // 右ペイン: 選択状態の表示は DOM を差し替えずに更新する。
  // DOM を作り直す rerender() を避けることで、
  // - 選択だけで一覧が再読み込みっぽく見える
  // - dblclick が成立しづらい
  // を防ぐ。
  let selectionUiRaf = null;

  // 右ペイン: クリップボード（copy/cut）
  // - mode: 'copy' | 'cut' | null
  // - paths: 対象パス配列
  let clipboard = { mode: null, paths: [] };

  // 右ペイン: キーボードショートカット適用範囲判定用
  let lastContentInteractionAt = 0;

  // DnD: 現在ドラッグ中のパス一覧（右/左どちらから開始しても共通で使う）
  let dragPaths = [];

  // 右ペイン: フォルダ上ホバーで自動オープンするためのタイマー
  let hoverOpenTimer = null;
  let hoverOpenPath = null;

  // 左ツリー: 選択状態（複数選択）
  let selectedTreePaths = new Set();
  let treeSelectionAnchorIndex = null;
  let lastTreeCwd = null;

  // 左ツリー: フォルダ上ホバーで自動展開するためのタイマー
  let hoverTreeExpandTimer = null;
  let hoverTreeExpandPath = null;

  // 左ツリー: インラインリネーム状態
  let treeRenameDraft = null;

  // アイコン画像キャッシュ（URL -> HTMLImageElement）
  // - 再描画のたびに <img> を作り直すとチラつきや再デコードが起きやすいので、
  //   src ごとに 1 つだけ保持し、cloneNode() で使い回す。
  const iconImgCache = new Map();

  const iconObjectUrlCache = new Map();

  const thumbObjectUrlCache = new Map();

  const transparentPixelDataUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function normalizeIconUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, window.location.href).toString();
    } catch {
      return url;
    }
  }

  function warmObjectUrlCache({ normalizedUrl, cache, cacheKey, queryAttr }) {
    if (!normalizedUrl || !cacheKey) return;
    const prev = cache.get(cacheKey);
    if (prev?.objectUrl) return;
    if (prev?.promise) return;

    const promise = (async () => {
      try {
        const res = await fetch(normalizedUrl, { cache: 'force-cache', credentials: 'same-origin' });
        if (!res.ok) return;
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        cache.set(cacheKey, { objectUrl, promise: null });

        try {
          appRootEl
            ?.querySelectorAll?.(`img[${queryAttr}="${CSS.escape(cacheKey)}"]`)
            ?.forEach?.((img) => {
              if (img && img.src !== objectUrl) img.src = objectUrl;
            });
        } catch {
          // ignore
        }
      } catch {
        cache.set(cacheKey, { objectUrl: '', promise: null });
      }
    })();

    cache.set(cacheKey, { objectUrl: '', promise });
  }

  function warmIconObjectUrl(url) {
    const key = normalizeIconUrl(url);
    if (!key) return;
    warmObjectUrlCache({ normalizedUrl: key, cache: iconObjectUrlCache, cacheKey: key, queryAttr: 'data-icon-url' });
  }

  function warmThumbObjectUrl({ url, cacheKey }) {
    const normalizedUrl = normalizeIconUrl(url);
    const key = (cacheKey ?? normalizedUrl ?? '').toString();
    if (!normalizedUrl || !key) return;
    warmObjectUrlCache({ normalizedUrl, cache: thumbObjectUrlCache, cacheKey: key, queryAttr: 'data-thumb-key' });
  }

  function resolveIconUrl(entry) {
    // 画像アイコン設定（config.json の icons）に基づいて、表示すべき URL を決める。
    // - folder / file / ext マップ（拡張子別）
    // - 未設定の場合は空文字を返し、CSS アイコンにフォールバックする
    const st = store.getState();
    const cfg = st?.iconsConfig && typeof st.iconsConfig === 'object' ? st.iconsConfig : null;
    if (!cfg) return '';

    if (entry?.isDir) {
      return typeof cfg.folder === 'string' ? cfg.folder : '';
    }

    const ext = fileExt(entry?.name);
    const extMap = cfg.ext && typeof cfg.ext === 'object' ? cfg.ext : null;
    if (ext && extMap && typeof extMap[ext] === 'string') return extMap[ext];
    return typeof cfg.file === 'string' ? cfg.file : '';
  }

  function createIconEl(entry, { size = 14, extraClass = '' } = {}) {
    // アイコン要素を生成する。
    // - icons 設定があれば <img>
    // - 無ければ従来の <span class="icon ...">（CSS mask）
    const url = resolveIconUrl(entry);
    if (url) {
      const key = normalizeIconUrl(url);
      const cached = iconObjectUrlCache.get(key);
      if (!cached || !cached.objectUrl) warmIconObjectUrl(key);

      let base = iconImgCache.get(key);
      if (!base) {
        base = new Image();
        base.alt = '';
        base.decoding = 'async';
        base.src = cached?.objectUrl || key;
        iconImgCache.set(key, base);
      }

      const img = document.createElement('img');
      img.className = `swefm-icon-img${extraClass ? ` ${extraClass}` : ''}`;
      img.width = size;
      img.height = size;
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.setAttribute('data-icon-url', key);

      const next = iconObjectUrlCache.get(key);
      if (next?.objectUrl) {
        img.src = next.objectUrl;
      } else {
        img.src = key;
      }
      return img;
    }

    const span = document.createElement('span');
    span.className = `icon${extraClass ? ` ${extraClass}` : ''} ${entry?.isDir ? 'icon-folder' : `icon-file ${extClass(entry?.name ?? '')}`}`;
    return span;
  }

  function emitOpenFile(path) {
    const fn = window?.sweFilemanagerOnOpenFile;
    if (typeof fn !== 'function') return false;
    const st = store.getState();
    try {
      const info = {
        root: st.currentRoot,
        path,
        name: (path ?? '').toString().split('/').filter(Boolean).pop() ?? '',
        downloadUrl: commands.getDownloadUrl(path),
      };
      return fn(info) === true;
    } catch {
      return false;
    }
  }

  function emitTreeSelection(paths) {
    // 外部連携フック: 左ツリーの選択が変わった時に通知する。
    // VSCode の Explorer 連携など、ホスト側で自由に使える。
    const fn = window?.sweFilemanagerOnSelectTree;
    const st = store.getState();
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    const info = {
      root: st.currentRoot,
      paths: list,
      primaryPath: list[0] ?? '',
    };
    try {
      // eslint-disable-next-line no-console
      console.log('[sweFilemanager] tree selection', info);
    } catch {
      // ignore
    }
    if (typeof fn === 'function') {
      try {
        fn(info);
      } catch {
        // ignore
      }
    }
  }

  async function doDropToDir(destDir, { copy = false } = {}) {
    // ドロップ確定時の処理。
    // - Ctrl/Meta 押下中は copy、それ以外は move
    // - 例外は alert で表示
    const list = Array.isArray(dragPaths) ? dragPaths.filter(Boolean) : [];
    if (list.length === 0) return;
    try {
      if (copy) {
        await commands.copyPaths(destDir, list);
      } else {
        await commands.movePaths(destDir, list);
      }
    } catch (e) {
      alert(e?.message ?? String(e));
    } finally {
      dragPaths = [];
    }
  }

  function cancelHoverOpen() {
    // 右ペイン: フォルダへホバーした時の「自動で開く」タイマーをキャンセル
    if (hoverOpenTimer != null) {
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = null;
    }
    hoverOpenPath = null;
  }

  function scheduleHoverOpen(dirPath) {
    // 右ペイン: フォルダへ一定時間ホバーすると自動遷移する。
    // DnD の時に、目的フォルダへ開いてからドロップできる UX。
    if (!dirPath) return;
    if (hoverOpenPath === dirPath && hoverOpenTimer != null) return;

    cancelHoverOpen();
    hoverOpenPath = dirPath;
    hoverOpenTimer = setTimeout(() => {
      hoverOpenTimer = null;
      const p = hoverOpenPath;
      hoverOpenPath = null;
      if (!p) return;
      commands.navigate(p).catch((e) => alert(e?.message ?? String(e)));
    }, 1500);
  }

  function clearDropTargets() {
    // 右ペイン: drop-target の見た目を一括解除
    document.querySelectorAll('.swefm-content .drop-target').forEach((el) => el.classList.remove('drop-target'));
  }

  function clearTreeDropTargets() {
    // 左ツリー: drop-target の見た目を一括解除
    treeEl?.querySelectorAll?.('.tree-item.drop-target')?.forEach?.((el) => el.classList.remove('drop-target'));
  }

  function cancelTreeHoverExpand() {
    // 左ツリー: ホバー展開タイマーをキャンセル
    if (hoverTreeExpandTimer != null) {
      clearTimeout(hoverTreeExpandTimer);
      hoverTreeExpandTimer = null;
    }
    hoverTreeExpandPath = null;
  }

  function scheduleTreeHoverExpand(dirPath) {
    // 左ツリー: DnD 中にフォルダへ一定時間ホバーすると自動で展開する。
    // - 未ロードなら loadDirs
    // - expanded=true にして store にダミー更新を入れて再描画させる
    if (!dirPath) return;
    if (hoverTreeExpandPath === dirPath && hoverTreeExpandTimer != null) return;

    cancelTreeHoverExpand();
    hoverTreeExpandPath = dirPath;
    hoverTreeExpandTimer = setTimeout(async () => {
      hoverTreeExpandTimer = null;
      const p = hoverTreeExpandPath;
      hoverTreeExpandPath = null;
      if (!p) return;
      try {
        const st = commands.getTreeState().get(p);
        if (!st || !st.loaded) {
          await commands.loadDirs(p);
          commands.setNodeState(p, { expanded: true });
        } else {
          commands.setNodeState(p, { expanded: true });
        }
        store.setState((s) => s);
      } catch (e) {
        alert(e?.message ?? String(e));
      }
    }, 1500);
  }

  function bindTreeDropTarget(el, destDir) {
    // 左ツリーの1要素を「ドロップ先」として扱うイベントを設定。
    // - dragPaths に含まれる（自分自身への移動）場合は拒否
    // - ondragenter で drop-target ハイライト + ホバー展開予約
    if (!el) return;
    el.ondragenter = (e) => {
      if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
      if (dragPaths.includes(destDir)) return;
      e.preventDefault();
      clearTreeDropTargets();
      el.classList.add('drop-target');
      scheduleTreeHoverExpand(destDir);
    };
    el.ondragover = (e) => {
      if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
      if (dragPaths.includes(destDir)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move';
    };
    el.ondragleave = (e) => {
      const rt = e?.relatedTarget;
      if (rt && el.contains(rt)) return;
      el.classList.remove('drop-target');
      if (hoverTreeExpandPath === destDir) cancelTreeHoverExpand();
    };
    el.ondrop = (e) => {
      if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
      if (dragPaths.includes(destDir)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      clearTreeDropTargets();
      cancelHoverOpen();
      cancelTreeHoverExpand();
      const copy = e.ctrlKey || e.metaKey;
      doDropToDir(destDir, { copy });
    };
  }

  function bindContentBackgroundDrop(el) {
    // 右ペイン背景（行/グリッド以外の空白）へのドロップ。
    // - 現在の cwd への move/copy として扱う
    if (!el) return;
    el.ondragover = (e) => {
      if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
      const t = e?.target;
      const onTableRow = t?.closest ? t.closest('tr') : null;
      const onGridItem = t?.closest ? t.closest('.grid-item') : null;
      if (onTableRow || onGridItem) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move';
    };
    el.ondrop = (e) => {
      if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
      const t = e?.target;
      const onTableRow = t?.closest ? t.closest('tr') : null;
      const onGridItem = t?.closest ? t.closest('.grid-item') : null;
      if (onTableRow || onGridItem) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropTargets();
      cancelHoverOpen();
      const { cwd } = store.getState();
      const destDir = cwd ?? '';
      const copy = e.ctrlKey || e.metaKey;
      doDropToDir(destDir, { copy });
    };
  }

  const uiRoot = document.querySelector('.sweFilemanager') ?? document.body;

  const ctxMenuEl = document.createElement('div');
  // 右ペイン用のカスタムコンテキストメニュー（OS標準の右クリックメニューではない）
  ctxMenuEl.className = 'swefm-ctxmenu';
  ctxMenuEl.hidden = true;
  ctxMenuEl.onclick = (e) => {
    e?.stopPropagation?.();
  };
  ctxMenuEl.oncontextmenu = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
  };
  uiRoot.appendChild(ctxMenuEl);

  const propModalEl = document.createElement('div');
  // プロパティ表示のポップオーバー（簡易モーダル）
  propModalEl.className = 'swefm-prop-popover';
  propModalEl.hidden = true;
  propModalEl.onclick = (e) => {
    e?.stopPropagation?.();
  };
  propModalEl.oncontextmenu = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
  };
  uiRoot.appendChild(propModalEl);

  function hideContextMenu() {
    // 表示中のコンテキストメニューを閉じる
    ctxMenuEl.hidden = true;
    ctxMenuEl.innerHTML = '';
  }

  function hidePropertyModal() {
    // 表示中のプロパティポップオーバーを閉じる
    propModalEl.hidden = true;
    propModalEl.innerHTML = '';
  }

  document.addEventListener('click', (e) => {
    // クリックでメニュー/プロパティを閉じる。
    // さらに「右ペイン空白クリックで選択解除」もここで行う。
    hideContextMenu();
    hidePropertyModal();

    const t = e?.target;
    const inContent = t && t.closest ? t.closest('.swefm-content') : null;
    if (!inContent) return;

    lastContentInteractionAt = Date.now();

    const onTableRow = t.closest ? t.closest('tr') : null;
    const onGridItem = t.closest ? t.closest('.grid-item') : null;
    if (onTableRow || onGridItem) return;

    if (selectedPaths.size > 0) {
      selectedPaths = new Set();
      selectionAnchorIndex = null;
      rerender();
    }
  });

  document.addEventListener(
    'click',
    (e) => {
      // href="#" のリンクが残っていると、preventDefault が漏れた場合に
      // ハッシュ遷移（見た目のリロード/スクロール）が起きるためガードする。
      const t = e?.target;
      const a = t?.closest ? t.closest('a') : null;
      if (!a) return;
      if (a.getAttribute('href') !== '#') return;
      if (appRootEl && !appRootEl.contains(a)) return;
      e.preventDefault();
    },
    true
  );

  window.addEventListener('beforeunload', () => {
    try {
      for (const v of iconObjectUrlCache.values()) {
        if (v?.objectUrl) URL.revokeObjectURL(v.objectUrl);
      }
      for (const v of thumbObjectUrlCache.values()) {
        if (v?.objectUrl) URL.revokeObjectURL(v.objectUrl);
      }
    } catch {
      // ignore
    }
  });
  document.addEventListener('keydown', (e) => {
    // キーボードショートカット。
    // - Esc: メニュー/プロパティを閉じる
    // - Ctrl/Meta + C/X/V: copy/cut/paste
    // NOTE: 入力中（input/textarea/contenteditable）は無視
    if (e.key === 'Escape') {
      hideContextMenu();
      hidePropertyModal();

		// アップロードモーダルが開いている場合は閉じる
		if (uploadModalEl && uploadModalEl.hidden === false) {
			closeUploadModal();
		}
      return;
    }

    const isCtrl = e.ctrlKey === true || e.metaKey === true;
    if (!isCtrl) return;

    const active = document.activeElement;
    const tag = active?.tagName?.toLowerCase?.() ?? '';
    const isTyping = tag === 'input' || tag === 'textarea' || active?.isContentEditable === true;
    if (isTyping) return;

    if (Date.now() - lastContentInteractionAt > 30_000) return;

    const k = (e.key ?? '').toLowerCase();
    if (k === 'c') {
      if (selectedPaths.size === 0) return;
      e.preventDefault();
      setClipboard('copy', Array.from(selectedPaths));
      return;
    }
    if (k === 'x') {
      if (selectedPaths.size === 0) return;
      e.preventDefault();
      setClipboard('cut', Array.from(selectedPaths));
      return;
    }
    if (k === 'v') {
      if (!canPaste()) return;
      e.preventDefault();
      doPaste().catch((err) => alert(err?.message ?? String(err)));
      return;
    }
  });
  window.addEventListener('scroll', () => {
    // スクロールするとメニューが位置ずれするため閉じる
    hideContextMenu();
  });

  function menuItem(label, onClick, { danger = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swefm-ctxitem';
    if (danger) btn.classList.add('danger');
    btn.textContent = label;
    btn.onclick = async (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      hideContextMenu();
      await onClick?.();
    };
    return btn;
  }

  function openEntry(entry) {
    if (entry.isDir) {
      commands.navigate(entry.path);
    } else {
      // sweFilemanagerOnOpenFile が設定されていればそちらを優先し、
      // 未設定または false 返却の場合のみダウンロードにフォールバック
      if (!emitOpenFile(entry.path)) {
        commands.download(entry.path);
      }
    }
  }

  function setClipboard(mode, paths) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    clipboard = { mode: mode ?? null, paths: list };
  }

  function canPaste() {
    return (clipboard?.mode === 'copy' || clipboard?.mode === 'cut') && Array.isArray(clipboard.paths) && clipboard.paths.length > 0;
  }

  function cancelSelectionRerender() {
    if (selectionUiRaf != null) {
      cancelAnimationFrame(selectionUiRaf);
      selectionUiRaf = null;
    }
  }

  function rerenderSelectionOnly() {
    if (btnDelete) btnDelete.disabled = selectedPaths.size === 0;

    try {
      tbody?.querySelectorAll?.('tr[data-path]')?.forEach?.((tr) => {
        const p = tr.getAttribute('data-path') ?? '';
        tr.classList.toggle('selected', selectedPaths.has(p));
      });
    } catch {
      // ignore
    }

    try {
      gridEl?.querySelectorAll?.('.grid-item[data-path]')?.forEach?.((el) => {
        const p = el.getAttribute('data-path') ?? '';
        el.classList.toggle('selected', selectedPaths.has(p));
      });
    } catch {
      // ignore
    }
  }

  function scheduleSelectionRerender() {
    cancelSelectionRerender();
    selectionUiRaf = requestAnimationFrame(() => {
      selectionUiRaf = null;
      rerenderSelectionOnly();
    });
  }

  async function doPaste() {
    if (!canPaste()) return;
    const { cwd } = store.getState();
    const destDir = cwd ?? '';
    if (clipboard.mode === 'cut') {
      await commands.movePaths(destDir, clipboard.paths);
      setClipboard(null, []);
      selectedPaths = new Set();
      selectionAnchorIndex = null;
      rerender();
      return;
    }
    if (clipboard.mode === 'copy') {
      await commands.copyPaths(destDir, clipboard.paths);
      return;
    }
  }

  function setSelectionOnly(path, { anchorIndex = null } = {}) {
    selectedPaths = new Set(path ? [path] : []);
    selectionAnchorIndex = anchorIndex;
    scheduleSelectionRerender();
  }

  function toggleSelection(path, { anchorIndex = null } = {}) {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selectedPaths = next;
    selectionAnchorIndex = anchorIndex;
    scheduleSelectionRerender();
  }

  function setSelectionRange(pathsInOrder, fromIdx, toIdx) {
    const a = Math.min(fromIdx, toIdx);
    const b = Math.max(fromIdx, toIdx);
    const next = new Set();
    for (let i = a; i <= b; i += 1) {
      const p = pathsInOrder[i];
      if (p) next.add(p);
    }
    selectedPaths = next;
    scheduleSelectionRerender();
  }

  function handleSelectClick(e, entry, index, pathsInOrder) {
    if (entry?.__draft) return;
    const path = entry.path;
    if (!path) return;

    const isCtrl = e?.ctrlKey === true || e?.metaKey === true;
    const isShift = e?.shiftKey === true;

    if (isShift) {
      const anchor = selectionAnchorIndex != null ? selectionAnchorIndex : index;
      setSelectionRange(pathsInOrder, anchor, index);
      return;
    }

    if (isCtrl) {
      toggleSelection(path, { anchorIndex: index });
      return;
    }

    setSelectionOnly(path, { anchorIndex: index });
  }

  async function showProperty(entry, { x = lastCtxX, y = lastCtxY } = {}) {
    // プロパティ表示。
    // - サーバから stat を取り、ポップオーバーとして表示
    // - 表示位置は contextmenu の座標を基準に、画面外にはみ出ないよう補正
    try {
      const st = await commands.statPath(entry.path);
      propModalEl.innerHTML = '';

      const dialog = document.createElement('div');
      dialog.className = 'swefm-prop-dialog';

      const head = document.createElement('div');
      head.className = 'swefm-prop-head';

      const title = document.createElement('div');
      title.className = 'swefm-prop-title';
      title.textContent = 'Property';

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'swefm-prop-close';
      close.textContent = '×';
      close.onclick = () => hidePropertyModal();

      head.appendChild(title);
      head.appendChild(close);

      const body = document.createElement('div');
      body.className = 'swefm-prop-body';

      const rows = [
        ['name', st?.name ?? entry.name],
        ['path', `/${st?.path ?? entry.path}`],
        ['size', entry.isDir ? '' : fmtBytes(st?.size ?? entry.size)],
        ['mtime', fmtTime(st?.mtimeMs ?? entry.mtimeMs)],
        ['mode', st?.mode ?? ''],
        ['owner', st?.owner ?? ''],
        ['group', st?.group ?? ''],
      ];
      for (const [k, v] of rows) {
        const r = document.createElement('div');
        r.className = 'swefm-prop-row';
        const kk = document.createElement('div');
        kk.className = 'swefm-prop-key';
        kk.textContent = k;
        const vv = document.createElement('div');
        vv.className = 'swefm-prop-val';
        vv.textContent = v == null ? '' : String(v);
        r.appendChild(kk);
        r.appendChild(vv);
        body.appendChild(r);
      }

      dialog.appendChild(head);
      dialog.appendChild(body);
      propModalEl.appendChild(dialog);
      propModalEl.hidden = false;

      propModalEl.style.left = `${Math.max(6, x)}px`;
      propModalEl.style.top = `${Math.max(6, y)}px`;

      const rect = propModalEl.getBoundingClientRect();
      let nx = x;
      let ny = y;
      if (rect.right > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - rect.width - 6);
      if (rect.bottom > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - rect.height - 6);
      propModalEl.style.left = `${nx}px`;
      propModalEl.style.top = `${ny}px`;
    } catch (e) {
      alert(e?.message ?? String(e));
    }
  }

  function showContextMenu(entry, x, y) {
    // 右クリック時のコンテキストメニュー。
    // - 複数選択中に選択内を右クリックした場合は「その複数」へ適用
    // - 単体右クリックの場合は、その1件へ適用
    ctxMenuEl.innerHTML = '';

    lastCtxX = x;
    lastCtxY = y;

    const currentSelection = selectedPaths.has(entry.path) ? Array.from(selectedPaths) : [entry.path];

    ctxMenuEl.appendChild(
      menuItem('open', async () => {
        openEntry(entry);
      })
    );

    ctxMenuEl.appendChild(
      menuItem('copy', async () => {
        setClipboard('copy', currentSelection);
      })
    );
    ctxMenuEl.appendChild(
      menuItem('cut', async () => {
        setClipboard('cut', currentSelection);
      })
    );
    if (canPaste()) {
      ctxMenuEl.appendChild(
        menuItem('paste', async () => {
          try {
            await doPaste();
          } catch (e) {
            alert(e?.message ?? String(e));
          }
        })
      );
    }
    ctxMenuEl.appendChild(
      menuItem('rename', async () => {
        renameDraft = { path: entry.path };
        rerender();
      })
    );
    ctxMenuEl.appendChild(
      menuItem(
        'delete',
        async () => {
          const count = currentSelection.length;
          const label = count === 1 ? entry.name : `${count} items`;
          if (!confirm(`${label} を削除しますか？`)) return;
          try {
            if (count === 1) {
              await commands.deletePath(entry.path);
            } else {
              await commands.deletePaths(currentSelection);
            }
            selectedPaths = new Set();
            selectionAnchorIndex = null;
            rerender();
          } catch (e) {
            alert(e?.message ?? String(e));
          }
        },
        { danger: true }
      )
    );

    ctxMenuEl.appendChild(
      menuItem('move', async () => {
        const count = currentSelection.length;
        const destDir = prompt('移動先フォルダ (相対パス)', '');
        if (destDir == null) return;
        try {
          await commands.movePaths(destDir.trim(), currentSelection);
          selectedPaths = new Set();
          selectionAnchorIndex = null;
          rerender();
        } catch (e) {
          alert(e?.message ?? String(e));
        }
      })
    );
    ctxMenuEl.appendChild(
      menuItem('property', async () => {
        await showProperty(entry, { x: lastCtxX, y: lastCtxY });
      })
    );

    ctxMenuEl.style.left = `${Math.max(6, x)}px`;
    ctxMenuEl.style.top = `${Math.max(6, y)}px`;
    ctxMenuEl.hidden = false;

    const rect = ctxMenuEl.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (rect.right > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - rect.width - 6);
    if (rect.bottom > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - rect.height - 6);
    ctxMenuEl.style.left = `${nx}px`;
    ctxMenuEl.style.top = `${ny}px`;
  }

  function rerender() {
    // store を「同じ値で更新」して購読者（View）を再描画させる。
    // UI 内部 state（selectedPaths 等）だけ変わった場合に使う。
    store.setState((s) => s);
  }

  function setStatus(text) {
    // 右下ステータス領域のテキストを更新
    statusEl.textContent = text;
  }

  function setUploadBusy(busy) {
    if (uploadBusyEl) uploadBusyEl.hidden = busy !== true;
    if (btnUploadChoose) btnUploadChoose.disabled = busy === true;
    if (btnUploadClose) btnUploadClose.disabled = busy === true;
    if (uploadDropEl) uploadDropEl.style.pointerEvents = busy === true ? 'none' : '';
    if (uploadModalBackdropEl) uploadModalBackdropEl.style.pointerEvents = busy === true ? 'none' : '';
  }

  function clearUploadLog() {
    if (!uploadLogEl) return;
    uploadLogEl.innerHTML = '';
  }

  function pushUploadLog(text) {
    if (!uploadLogEl) return;
    const el = document.createElement('div');
    el.className = 'swefm-upload-log-item';
    el.textContent = text;
    uploadLogEl.appendChild(el);
    const items = uploadLogEl.querySelectorAll('.swefm-upload-log-item');
    if (items.length > 8) {
      for (let i = 0; i < items.length - 8; i += 1) items[i].remove();
    }
    const remove = () => {
      try {
        el.remove();
      } catch {
        // ignore
      }
    };
    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 2200);
  }

  function openUploadModal() {
    if (!uploadModalEl) return;
    uploadModalEl.hidden = false;
    uploadDropEl?.classList?.remove?.('is-dragover');
    setUploadBusy(false);
    clearUploadLog();
  }

  function closeUploadModal() {
    if (!uploadModalEl) return;
    uploadModalEl.hidden = true;
    uploadDropEl?.classList?.remove?.('is-dragover');
    setUploadBusy(false);
    clearUploadLog();
  }

  async function uploadFiles(files) {
    const list = Array.isArray(files) ? files : [];
    if (list.length === 0) return;
    setUploadBusy(true);
    try {
      for (let i = 0; i < list.length; i += 1) {
        const name = list[i]?.name ? list[i].name : 'file';
        pushUploadLog(`upload: ${name}`);
        setStatus(list.length > 1 ? `アップロード中... (${i + 1}/${list.length})` : 'アップロード中...');
        await commands.uploadFile(list[i]);
      }
    } finally {
      setUploadBusy(false);
    }
  }

  async function readEntry(entry, baseDir = '') {
    const out = [];
    if (!entry) return out;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        try {
          entry.file(resolve, reject);
        } catch (e) {
          reject(e);
        }
      });
      out.push({ file, dir: baseDir });
      return out;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const childBase = baseDir ? `${baseDir}/${entry.name}` : entry.name;
      while (true) {
        const entries = await new Promise((resolve, reject) => {
          try {
            reader.readEntries(resolve, reject);
          } catch (e) {
            reject(e);
          }
        });
        if (!entries || entries.length === 0) break;
        for (const ent of entries) {
          const sub = await readEntry(ent, childBase);
          for (const it of sub) out.push(it);
        }
      }
    }
    return out;
  }

  function snapshotDrop(dt) {
    // drop イベントの DataTransfer は非同期処理中に参照できなくなることがあるため、
    // 必要な情報は同期的にスナップショットしておく。
    const files = Array.from(dt?.files ?? []);
    const items = Array.from(dt?.items ?? []);
    const entries = items
      .map((it) => {
        try {
          return typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { files, entries };
  }

  async function extractDroppedFiles({ files, entries }) {
    const fileList = Array.isArray(files) ? files : [];
    const entryList = Array.isArray(entries) ? entries : [];
    if (entryList.length === 0) {
      return fileList.map((file) => ({ file, dir: '' }));
    }

    const hasDirectory = entryList.some((e) => e?.isDirectory === true);
    if (!hasDirectory) {
      // フォルダが無い（ファイルのみ）の場合は files を使う方が確実に全件取れる。
      return fileList.map((file) => ({ file, dir: '' }));
    }

    const results = [];
    for (const entry of entryList) {
      const list = await readEntry(entry, '');
      for (const x of list) results.push(x);
    }
    return results;
  }

  async function uploadDroppedEntries(entries) {
    const list = Array.isArray(entries) ? entries.filter((x) => x?.file) : [];
    if (list.length === 0) return;
    setUploadBusy(true);
    try {
      const dirs = new Set();
      for (const it of list) {
        const d = (it.dir ?? '').toString().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        if (d) dirs.add(d);
      }
      for (const d of dirs) {
        await commands.ensureDirExists(d);
      }

      for (let i = 0; i < list.length; i += 1) {
        const it = list[i];
        const d = (it.dir ?? '').toString().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        const name = it?.file?.name ? it.file.name : 'file';
        pushUploadLog(d ? `upload: ${d}/${name}` : `upload: ${name}`);
        setStatus(list.length > 1 ? `アップロード中... (${i + 1}/${list.length})` : 'アップロード中...');
        await commands.uploadFileTo(d, it.file, { reload: false });
      }
      const { cwd } = store.getState();
      await commands.reloadDir(cwd, { expand: true });
      await commands.refresh();
    } finally {
      setUploadBusy(false);
    }
  }

  function renderBreadcrumb(p) {
    // パンくず（root / dir1 / dir2 ...）を組み立てる。
    // クリックするとその階層へ navigate。
    const parts = (p ?? '').split('/').filter(Boolean);
    const segs = [''];
    for (const part of parts) {
      const prev = segs[segs.length - 1];
      segs.push(prev ? `${prev}/${part}` : part);
    }

    breadcrumb.innerHTML = '';
    const rootLink = document.createElement('a');
    rootLink.href = '#';
    const rootSelect = document.getElementById('root-select');
    const rootLabel = rootSelect?.selectedOptions?.[0]?.textContent?.trim() ?? '';
    rootLink.textContent = rootLabel;
    rootLink.onclick = (e) => {
      e.preventDefault();
      commands.navigate('');
    };
    if (rootLabel) breadcrumb.appendChild(rootLink);

    for (let i = 1; i < segs.length; i += 1) {
      if (breadcrumb.childNodes.length > 0) breadcrumb.appendChild(document.createTextNode(' / '));
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = parts[i - 1];
      const target = segs[i];
      a.onclick = (e) => {
        e.preventDefault();
        const { cwd } = store.getState();
        if ((cwd ?? '') === (target ?? '')) return;
        commands.navigate(target);
      };
      breadcrumb.appendChild(a);
    }
  }

  function rowActionButton(label, onClick, { danger = false } = {}) {
    // 行/グリッドの「小さい操作ボタン」生成。
    // クリックで選択や行クリックと競合しないよう stopPropagation する。
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (danger) btn.classList.add('danger');
    btn.onclick = async (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      await onClick?.(e);
    };
    return btn;
  }

  function createInlineInput({ initialValue, placeholder, onCommit, onCancel, commitOnBlur = false }) {
    // インライン入力（作成/リネーム用）。
    // - Enter: commit
    // - Esc: cancel
    // - blur 時の扱いは commitOnBlur で切り替え
    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialValue ?? '';
    if (placeholder) input.placeholder = placeholder;

    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      onCancel?.();
    };
    const commit = async () => {
      if (done) return;
      done = true;
      await onCommit?.(input.value);
    };

    input.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await commit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    input.onblur = async () => {
      if (commitOnBlur) {
        await commit();
        return;
      }
      cancel();
    };

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    return input;
  }

  function renderTable(listing) {
    // 右ペイン: リスト表示（table）
    // - selectedPaths/renameDraft/createDraft 等の UI state を反映
    // - DnD の dragstart/dragover/drop を行単位に付与
    tbody.innerHTML = '';

    const effectiveListing = Array.isArray(listing) ? listing.slice() : [];
    if (createDraft) {
      // createDraft がある場合、先頭に「入力行」を差し込む
      effectiveListing.unshift({
        name: '',
        isDir: createDraft.kind === 'dir',
        size: 0,
        mtimeMs: 0,
        path: '__draft__',
        __draft: true,
      });
    }

    const realEntries = effectiveListing.filter((e) => !e.__draft);
    const pathsInOrder = realEntries.map((e) => e.path);

    for (let i = 0; i < effectiveListing.length; i += 1) {
      const entry = effectiveListing[i];
      const tr = document.createElement('tr');
      if (entry.isDir) tr.classList.add('is-dir');
      if (!entry.__draft) tr.setAttribute('data-path', entry.path);
      if (!entry.__draft && selectedPaths.has(entry.path)) tr.classList.add('selected');

      const realIndex = entry.__draft ? -1 : pathsInOrder.indexOf(entry.path);
      if (!entry.__draft) {
        // 通常行: クリックで選択（shift/ctrl に対応）
        tr.onclick = (e) => {
          handleSelectClick(e, entry, realIndex, pathsInOrder);
        };

        // DnD: 選択中アイテムをまとめてドラッグ対象にする
        tr.draggable = true;
        tr.ondragstart = (e) => {
          if (!selectedPaths.has(entry.path)) {
            setSelectionOnly(entry.path, { anchorIndex: realIndex });
          }
          dragPaths = Array.from(selectedPaths);
          try {
            e.dataTransfer?.setData('text/plain', dragPaths.join('\n'));
            e.dataTransfer.effectAllowed = 'copyMove';
          } catch {
            // ignore
          }
        };
        tr.ondragend = () => {
          // ドラッグ終了でハイライトとタイマーを解除
          clearDropTargets();
          cancelHoverOpen();
          dragPaths = [];
        };

        if (entry.isDir) {
          // ディレクトリ行は「ドロップ先」になれる
          tr.ondragenter = (e) => {
            if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
            if (dragPaths.includes(entry.path)) return;
            e.preventDefault();
            scheduleHoverOpen(entry.path);
          };
          tr.ondragover = (e) => {
            if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
            if (dragPaths.includes(entry.path)) return;
            e.preventDefault();
            clearDropTargets();
            tr.classList.add('drop-target');
            e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move';
          };
          tr.ondragleave = (e) => {
            const rt = e?.relatedTarget;
            if (rt && tr.contains(rt)) return;
            tr.classList.remove('drop-target');
            if (hoverOpenPath === entry.path) cancelHoverOpen();
          };
          tr.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            tr.classList.remove('drop-target');
            cancelHoverOpen();
            const copy = e.ctrlKey || e.metaKey;
            doDropToDir(entry.path, { copy });
          };
        }
      }

      const tdName = document.createElement('td');
      const nameWrap = document.createElement('span');
      nameWrap.className = 'name';

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = entry.isDir ? 'DIR' : 'FILE';

      const icon = createIconEl(entry);
      // アイコンのダブルクリックでも open（フォルダは navigate / ファイルはコールバック優先）
      icon.ondblclick = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        cancelSelectionRerender();
        if (entry.isDir) {
          commands.navigate(entry.path);
        } else {
          if (!emitOpenFile(entry.path)) {
            commands.download(entry.path);
          }
        }
      };

      let nameEl;
      if (entry.__draft) {
        // 作成入力行
        nameEl = createInlineInput({
          initialValue: '',
          placeholder: entry.isDir ? 'フォルダ名' : 'ファイル名',
          onCommit: async (v) => {
            const name = (v ?? '').trim();
            if (!name) {
              createDraft = null;
              rerender();
              return;
            }
            try {
              if (entry.isDir) {
                await commands.createFolder(name);
              } else {
                await commands.createFile(name);
              }
              createDraft = null;
              rerender();
            } catch (e) {
              alert(e?.message ?? String(e));
              createDraft = null;
              rerender();
            }
          },
          onCancel: () => {
            createDraft = null;
            rerender();
          },
        });
      } else if (renameDraft && renameDraft.path === entry.path) {
        // リネーム入力行（blur で commit）
        nameEl = createInlineInput({
          initialValue: entry.name,
          placeholder: '新しい名前',
          commitOnBlur: true,
          onCommit: async (v) => {
            const newName = (v ?? '').trim();
            renameDraft = null;
            if (!newName || newName === entry.name) {
              rerender();
              return;
            }
            try {
              await commands.renamePath(entry.path, newName);
              rerender();
            } catch (e) {
              alert(e?.message ?? String(e));
              rerender();
            }
          },
          onCancel: () => {
            renameDraft = null;
            rerender();
          },
        });
      } else {
        // 通常表示
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'link';
        a.textContent = entry.name;
        a.title = entry.name;
        a.draggable = false;
        a.ondragstart = (e) => {
          e?.preventDefault?.();
          e?.stopPropagation?.();
        };
        a.onclick = (e) => {
          e.preventDefault();
        };
        a.ondblclick = (e) => {
          e.preventDefault();
          cancelSelectionRerender();
          if (entry.isDir) {
            commands.navigate(entry.path);
          } else {
            if (!emitOpenFile(entry.path)) {
              commands.download(entry.path);
            }
          }
        };
        nameEl = a;
      }

      nameWrap.appendChild(badge);
      nameWrap.appendChild(icon);
      nameWrap.appendChild(nameEl);
      tdName.appendChild(nameWrap);

      const tdSize = document.createElement('td');
      tdSize.textContent = entry.isDir ? '' : fmtBytes(entry.size);

      const tdMtime = document.createElement('td');
      tdMtime.textContent = fmtTime(entry.mtimeMs);

      const tdActions = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'row-actions';

      if (!entry.__draft) {
        actions.appendChild(
          rowActionButton('名前変更', async () => {
            renameDraft = { path: entry.path };
            rerender();
          })
        );
      }

      if (!entry.isDir) {
        actions.appendChild(
          rowActionButton('DL', () => {
            commands.download(entry.path);
          })
        );
      }

      actions.appendChild(
        rowActionButton(
          '削除',
          async () => {
            if (!confirm(`${entry.name} を削除しますか？`)) return;
            try {
              await commands.deletePath(entry.path);
            } catch (e) {
              alert(e?.message ?? String(e));
            }
          },
          { danger: true }
        )
      );

      tdActions.appendChild(actions);

      if (!entry.__draft) {
        // 右クリックでメニュー表示（選択と連動）
        tr.oncontextmenu = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!selectedPaths.has(entry.path)) {
            setSelectionOnly(entry.path, { anchorIndex: realIndex });
          }
          showContextMenu(entry, e.clientX, e.clientY);
        };
      }

      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdMtime);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    }
  }

  function renderGrid(listing) {
    // 右ペイン: アイコン表示（grid）
    // - サムネ: 画像拡張子のみ downloadUrl を img.src にして表示
    // - それ以外はアイコン（img or CSS）
    // - DnD/選択/右クリックメニューは table と同等
    if (!gridEl) return;
    gridEl.innerHTML = '';
    const effectiveListing = Array.isArray(listing) ? listing.slice() : [];
    const realEntries = effectiveListing.filter((e) => !e.__draft);
    const pathsInOrder = realEntries.map((e) => e.path);
    for (const entry of effectiveListing) {
      const item = document.createElement('div');
      item.className = 'grid-item';
      if (entry.isDir) item.classList.add('is-dir');
      item.setAttribute('data-path', entry.path);
      if (selectedPaths.has(entry.path)) item.classList.add('selected');

      const realIndex = pathsInOrder.indexOf(entry.path);
      item.onclick = (e) => {
        if (renameDraft && renameDraft.path === entry.path) return;
        handleSelectClick(e, entry, realIndex, pathsInOrder);
      };

      item.draggable = true;
      item.ondragstart = (e) => {
        if (!selectedPaths.has(entry.path)) {
          setSelectionOnly(entry.path, { anchorIndex: realIndex });
        }
        dragPaths = Array.from(selectedPaths);
        try {
          e.dataTransfer?.setData('text/plain', dragPaths.join('\n'));
          e.dataTransfer.effectAllowed = 'copyMove';
        } catch {
          // ignore
        }
      };
      item.ondragend = () => {
        clearDropTargets();
        cancelHoverOpen();
        dragPaths = [];
      };

      if (entry.isDir) {
        item.ondragenter = (e) => {
          if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
          if (dragPaths.includes(entry.path)) return;
          e.preventDefault();
          scheduleHoverOpen(entry.path);
        };
        item.ondragover = (e) => {
          if (!Array.isArray(dragPaths) || dragPaths.length === 0) return;
          if (dragPaths.includes(entry.path)) return;
          e.preventDefault();
          clearDropTargets();
          item.classList.add('drop-target');
          e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move';
        };
        item.ondragleave = (e) => {
          const rt = e?.relatedTarget;
          if (rt && item.contains(rt)) return;
          item.classList.remove('drop-target');
          if (hoverOpenPath === entry.path) cancelHoverOpen();
        };
        item.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('drop-target');
          cancelHoverOpen();
          const copy = e.ctrlKey || e.metaKey;
          doDropToDir(entry.path, { copy });
        };
      }

      const top = document.createElement('div');
      top.className = 'grid-top';

      if (!entry.isDir && isImageFile(entry.name)) {
        const img = document.createElement('img');
        img.className = 'grid-thumb';
        img.loading = 'lazy';
        img.alt = entry.name;
        const url = commands.getThumbUrl(entry.path, { w: 160, h: 160, fit: 'cover', fmt: 'webp', q: 80 });
        const normalizedUrl = normalizeIconUrl(url);
        const thumbKey = `${normalizedUrl}|${entry.mtimeMs ?? ''}|${entry.size ?? ''}`;
        img.setAttribute('data-thumb-key', thumbKey);
        const cached = thumbObjectUrlCache.get(thumbKey);
        if (cached?.objectUrl) {
          img.src = cached.objectUrl;
        } else {
          // プレースホルダ方式: キャッシュができるまでネットワークURLを img.src に入れない
          // （DevTools の Network で毎回表示されるのが分かりづらい + 重い画像が多いと負荷が高い）
          img.src = transparentPixelDataUrl;
          warmThumbObjectUrl({ url: normalizedUrl, cacheKey: thumbKey });
        }
        top.appendChild(img);
      } else {
        const icon = createIconEl(entry, { size: 56, extraClass: 'grid-icon' });
        top.appendChild(icon);
      }

      const actions = document.createElement('div');
      actions.className = 'grid-actions';
      actions.appendChild(
        rowActionButton('名前変更', async () => {
          renameDraft = { path: entry.path };
          rerender();
        })
      );
      if (!entry.isDir) {
        actions.appendChild(
          rowActionButton('DL', () => {
            commands.download(entry.path);
          })
        );
      }
      actions.appendChild(
        rowActionButton(
          '削除',
          async () => {
            if (!confirm(`${entry.name} を削除しますか？`)) return;
            try {
              await commands.deletePath(entry.path);
            } catch (e) {
              alert(e?.message ?? String(e));
            }
          },
          { danger: true }
        )
      );

      top.appendChild(actions);
      item.appendChild(top);

      const name = document.createElement('div');
      name.className = 'grid-name';
      if (renameDraft && renameDraft.path === entry.path) {
        // グリッド: リネーム時はインライン input を表示
        const input = createInlineInput({
          initialValue: entry.name,
          placeholder: '新しい名前',
          commitOnBlur: true,
          onCommit: async (v) => {
            const newName = (v ?? '').trim();
            renameDraft = null;
            if (!newName || newName === entry.name) {
              rerender();
              return;
            }
            try {
              await commands.renamePath(entry.path, newName);
              rerender();
            } catch (e) {
              alert(e?.message ?? String(e));
              rerender();
            }
          },
          onCancel: () => {
            renameDraft = null;
            rerender();
          },
        });
        name.appendChild(input);
      } else {
        name.textContent = entry.name;
        name.title = entry.name;
      }
      item.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'grid-meta';
      meta.textContent = entry.isDir ? '' : fmtBytes(entry.size);
      item.appendChild(meta);

      item.ondblclick = () => {
        // ダブルクリックで open（コールバック優先、未設定時はダウンロード）
        if (renameDraft && renameDraft.path === entry.path) return;
        cancelSelectionRerender();
        if (entry.isDir) {
          commands.navigate(entry.path);
        } else {
          if (!emitOpenFile(entry.path)) {
            commands.download(entry.path);
          }
        }
      };

      item.oncontextmenu = (e) => {
        // 右クリックでコンテキストメニュー（table と同様に選択と連動）
        e.preventDefault();
        e.stopPropagation();
        if (!selectedPaths.has(entry.path)) {
          setSelectionOnly(entry.path, { anchorIndex: realIndex });
        }
        showContextMenu(entry, e.clientX, e.clientY);
      };

      gridEl.appendChild(item);
    }
  }

  async function renderTree(cwd) {
    // 左ツリーの描画。
    // - commands が持つ treeState（キャッシュ）を元に可視行を作り、DOMを組み立てる
    // - cwd が変わった場合は、選択を cwd へ追従させる
    const treeState = commands.getTreeState();
    if (lastTreeCwd !== cwd) {
      selectedTreePaths = new Set([cwd ?? '']);
      treeSelectionAnchorIndex = null;
      lastTreeCwd = cwd;
      emitTreeSelection(Array.from(selectedTreePaths));
    }
    treeEl.innerHTML = '';

    const rows = [];

    function pushNode(p) {
      // 展開状態に応じて rows に「表示行」を積む。
      // - row.entry がある場合は「ファイル行」
      // - row.st がある場合は「ディレクトリ行」
      const st = treeState.get(p) ?? { loaded: false, expanded: false, dirs: [], children: [] };
      const depth = depthOf(p);
      rows.push({ p, st, depth });
      if (st.expanded) {
        for (const child of st.children ?? []) {
          if (child?.isDir) {
            pushNode(child.path);
          } else {
            rows.push({ p: child.path, st: null, depth: depth + 1, entry: child });
          }
        }
      }
    }

    if (!treeState.has('')) {
      commands.setNodeState('', { loaded: false, expanded: true, dirs: [], children: [] });
    } else {
      commands.setNodeState('', { expanded: true });
    }

    pushNode('');

    const visiblePaths = rows.map((r) => (r.entry ? r.entry.path : r.p));

    function updateTreeSelectionUI() {
      try {
        treeEl?.querySelectorAll?.('.tree-item[data-path]')?.forEach?.((el) => {
          const p = el.getAttribute('data-path') ?? '';
          el.setAttribute('aria-selected', selectedTreePaths.has(p) ? 'true' : 'false');
        });
      } catch {
        // ignore
      }
    }

    function treeSetSelectionOnly(path, { anchorIndex = null } = {}) {
      // 左ツリー: 単一選択
      selectedTreePaths = new Set(path == null ? [] : [path]);
      treeSelectionAnchorIndex = anchorIndex;
      emitTreeSelection(Array.from(selectedTreePaths));
      updateTreeSelectionUI();
    }

    function treeToggleSelection(path, { anchorIndex = null } = {}) {
      // 左ツリー: ctrl/meta で選択トグル
      const next = new Set(selectedTreePaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      selectedTreePaths = next;
      treeSelectionAnchorIndex = anchorIndex;
      emitTreeSelection(Array.from(selectedTreePaths));
      updateTreeSelectionUI();
    }

    function treeRangeSelect(toIndex) {
      // 左ツリー: shift で範囲選択
      if (treeSelectionAnchorIndex == null) return;
      const a = treeSelectionAnchorIndex;
      const b = toIndex;
      const [from, to] = a < b ? [a, b] : [b, a];
      const next = new Set();
      for (let i = from; i <= to; i += 1) {
        const p = visiblePaths[i];
        if (p != null) next.add(p);
      }
      selectedTreePaths = next;
      emitTreeSelection(Array.from(selectedTreePaths));
      updateTreeSelectionUI();
    }

    function treeHandleSelectClick(e, path, index) {
      // 左ツリー: クリック選択の統一処理（shift/ctrl）
      const isShift = e.shiftKey === true;
      const isToggle = e.ctrlKey === true || e.metaKey === true;
      if (isShift) {
        if (treeSelectionAnchorIndex == null) {
          treeSetSelectionOnly(path, { anchorIndex: index });
          return;
        }
        treeRangeSelect(index);
        return;
      }
      if (isToggle) {
        treeToggleSelection(path, { anchorIndex: index });
        return;
      }
      treeSetSelectionOnly(path, { anchorIndex: index });
    }

    for (const row of rows) {
      if (row.entry) {
        // ツリー上の「ファイル行」
        const item = document.createElement('div');
        item.className = 'tree-item';
        if ((cwd ?? '') === row.entry.path) item.classList.add('is-cwd');
        item.setAttribute('role', 'treeitem');
        item.setAttribute('data-path', row.entry.path);
        item.setAttribute('aria-selected', selectedTreePaths.has(row.entry.path) ? 'true' : 'false');

        for (let i = 0; i < row.depth; i += 1) {
          const ind = document.createElement('span');
          ind.className = 'tree-indent';
          item.appendChild(ind);
        }

        const twist = document.createElement('span');
        twist.className = 'tree-twist';
        twist.textContent = '';
        item.appendChild(twist);

        const isDir = row.entry.isDir === true;

        const icon = createIconEl(row.entry);
        item.appendChild(icon);

        const isRenaming = treeRenameDraft && treeRenameDraft.path === row.entry.path;
        if (isRenaming) {
          const input = createInlineInput({
            initialValue: row.entry.name,
            placeholder: '新しい名前',
            commitOnBlur: true,
            onCommit: async (v) => {
              const newName = (v ?? '').trim();
              treeRenameDraft = null;
              if (!newName || newName === row.entry.name) {
                rerenderTreeOnly();
                return;
              }
              try {
                await commands.renamePath(row.entry.path, newName);
              } catch (e) {
                alert(e?.message ?? String(e));
              }
              rerenderTreeOnly();
            },
            onCancel: () => {
              treeRenameDraft = null;
              rerenderTreeOnly();
            },
          });
          item.appendChild(input);
        } else {
          const label = document.createElement('span');
          label.className = 'tree-label';
          label.textContent = row.entry.name;
          item.appendChild(label);
        }

        item.onclick = (e) => {
          // ツリー選択（複数選択対応）
          e?.preventDefault?.();
          e?.stopPropagation?.();
          if (treeRenameDraft && treeRenameDraft.path === row.entry.path) return;
          const idx = visiblePaths.indexOf(row.entry.path);
          if (isDir && e.shiftKey !== true && e.ctrlKey !== true && e.metaKey !== true) {
            treeSetSelectionOnly(row.entry.path, { anchorIndex: idx });
            commands.openDir(row.entry.path).catch((err) => alert(err?.message ?? String(err)));
            return;
          }
          treeHandleSelectClick(e, row.entry.path, idx);
        };

        item.draggable = true;
        item.ondragstart = (e) => {
          // ツリーからのドラッグ開始（複数選択をまとめて dragPaths にする）
          const idx = visiblePaths.indexOf(row.entry.path);
          if (!selectedTreePaths.has(row.entry.path)) {
            treeSetSelectionOnly(row.entry.path, { anchorIndex: idx });
          }
          dragPaths = Array.from(selectedTreePaths);
          try {
            e.dataTransfer?.setData('text/plain', dragPaths.join('\n'));
            e.dataTransfer.effectAllowed = 'copyMove';
          } catch {
            // ignore
          }
        };
        item.ondragend = () => {
          clearTreeDropTargets();
          cancelTreeHoverExpand();
          dragPaths = [];
        };

        item.ondblclick = async (e) => {
          // ツリー: ダブルクリック
          // - ディレクトリ: navigate
          // - ファイル: 外部フック（エディタ連携）へ渡す
          e?.preventDefault?.();
          e?.stopPropagation?.();
          if (treeRenameDraft && treeRenameDraft.path === row.entry.path) return;
          if (isDir) {
            await commands.navigate(row.entry.path);
          } else {
            emitOpenFile(row.entry.path);
          }
        };

        if (isDir) {
          bindTreeDropTarget(item, row.entry.path);
        }

        item.oncontextmenu = async (e) => {
          // ツリー: 右クリックメニュー（open/rename/delete/property）
          e?.preventDefault?.();
          e?.stopPropagation?.();

          if (!selectedTreePaths.has(row.entry.path)) {
            const idx = visiblePaths.indexOf(row.entry.path);
            treeSetSelectionOnly(row.entry.path, { anchorIndex: idx });
          }

          lastCtxX = e.clientX;
          lastCtxY = e.clientY;

          const entry = {
            name: row.entry.name,
            path: row.entry.path,
            isDir,
            size: null,
            mtimeMs: null,
          };

          ctxMenuEl.innerHTML = '';
          ctxMenuEl.appendChild(
            menuItem('open', async () => {
              openEntry(entry);
            })
          );
          ctxMenuEl.appendChild(
            menuItem('rename', async () => {
              treeRenameDraft = { path: entry.path };
              rerenderTreeOnly();
            })
          );
          ctxMenuEl.appendChild(
            menuItem(
              'delete',
              async () => {
                if (!confirm(`${entry.name} を削除しますか？`)) return;
                try {
                  await commands.deletePath(entry.path);
                } catch (err) {
                  alert(err?.message ?? String(err));
                }
              },
              { danger: true }
            )
          );
          ctxMenuEl.appendChild(
            menuItem('property', async () => {
              await showProperty(entry, { x: lastCtxX, y: lastCtxY });
            })
          );

          ctxMenuEl.style.left = `${Math.max(6, e.clientX)}px`;
          ctxMenuEl.style.top = `${Math.max(6, e.clientY)}px`;
          ctxMenuEl.hidden = false;

          const rect = ctxMenuEl.getBoundingClientRect();
          let nx = e.clientX;
          let ny = e.clientY;
          if (rect.right > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - rect.width - 6);
          if (rect.bottom > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - rect.height - 6);
          ctxMenuEl.style.left = `${nx}px`;
          ctxMenuEl.style.top = `${ny}px`;
        };

        treeEl.appendChild(item);
        continue;
      }

      const item = document.createElement('div');
      // ツリー上の「ディレクトリ行」
      item.className = 'tree-item';
      if ((cwd ?? '') === row.p) item.classList.add('is-cwd');
      item.setAttribute('role', 'treeitem');
      item.setAttribute('data-path', row.p);
      item.setAttribute('aria-selected', selectedTreePaths.has(row.p) ? 'true' : 'false');

      for (let i = 0; i < row.depth; i += 1) {
        const ind = document.createElement('span');
        ind.className = 'tree-indent';
        item.appendChild(ind);
      }

      const twist = document.createElement('span');
      twist.className = 'tree-twist';
      const canExpand = !row.st.loaded || (row.st.children?.length ?? 0) > 0;
      twist.textContent = canExpand ? (row.st.expanded ? '▾' : '▸') : '';
      twist.onclick = async (e) => {
        // ▸/▾ をクリックした時の展開/折りたたみ
        e.stopPropagation();
        if (!canExpand) return;
        try {
          if (!row.st.loaded) {
            await commands.loadDirs(row.p);
            commands.setNodeState(row.p, { expanded: true });
          } else {
            commands.setNodeState(row.p, { expanded: !row.st.expanded });
          }
          await renderTree(store.getState().cwd);
        } catch (err) {
          alert(err?.message ?? String(err));
        }
      };
      item.appendChild(twist);

      const icon = createIconEl({ isDir: true, name: '' });
      item.appendChild(icon);

      const label = document.createElement('span');
      const dirName = getDirName(row.p);
      const isRenaming = treeRenameDraft && treeRenameDraft.path === row.p;
      if (isRenaming) {
        const input = createInlineInput({
          initialValue: dirName,
          placeholder: '新しい名前',
          commitOnBlur: true,
          onCommit: async (v) => {
            const newName = (v ?? '').trim();
            treeRenameDraft = null;
            if (!newName || newName === dirName) {
              rerenderTreeOnly();
              return;
            }
            try {
              await commands.renamePath(row.p, newName);
            } catch (e) {
              alert(e?.message ?? String(e));
            }
            rerenderTreeOnly();
          },
          onCancel: () => {
            treeRenameDraft = null;
            rerenderTreeOnly();
          },
        });
        item.appendChild(input);
      } else {
        label.className = 'tree-label';
        label.textContent = dirName;
        item.appendChild(label);
      }

      item.onclick = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        if (treeRenameDraft && treeRenameDraft.path === row.p) return;
        const idx = visiblePaths.indexOf(row.p);
        if (e.shiftKey !== true && e.ctrlKey !== true && e.metaKey !== true) {
          treeSetSelectionOnly(row.p, { anchorIndex: idx });
          commands.openDir(row.p).catch((err) => alert(err?.message ?? String(err)));
          return;
        }
        treeHandleSelectClick(e, row.p, idx);
      };

      item.draggable = true;
      item.ondragstart = (e) => {
        const idx = visiblePaths.indexOf(row.p);
        if (!selectedTreePaths.has(row.p)) {
          treeSetSelectionOnly(row.p, { anchorIndex: idx });
        }
        dragPaths = Array.from(selectedTreePaths);
        try {
          e.dataTransfer?.setData('text/plain', dragPaths.join('\n'));
          e.dataTransfer.effectAllowed = 'copyMove';
        } catch {
          // ignore
        }
      };
      item.ondragend = () => {
        clearTreeDropTargets();
        cancelTreeHoverExpand();
        dragPaths = [];
      };

      item.ondblclick = async (e) => {
        // ディレクトリ行のダブルクリックで移動
        e?.preventDefault?.();
        e?.stopPropagation?.();
        if (treeRenameDraft && treeRenameDraft.path === row.p) return;
        await commands.navigate(row.p);
      };

      bindTreeDropTarget(item, row.p);

      item.oncontextmenu = async (e) => {
        // ディレクトリ行の右クリックメニュー
        e?.preventDefault?.();
        e?.stopPropagation?.();

        if (!selectedTreePaths.has(row.p)) {
          const idx = visiblePaths.indexOf(row.p);
          treeSetSelectionOnly(row.p, { anchorIndex: idx });
        }

        lastCtxX = e.clientX;
        lastCtxY = e.clientY;

        const entry = {
          name: getDirName(row.p),
          path: row.p,
          isDir: true,
          size: null,
          mtimeMs: null,
        };

        ctxMenuEl.innerHTML = '';
        ctxMenuEl.appendChild(
          menuItem('open', async () => {
            openEntry(entry);
          })
        );
        if (entry.path !== '') {
          ctxMenuEl.appendChild(
            menuItem('rename', async () => {
              treeRenameDraft = { path: entry.path };
              rerenderTreeOnly();
            })
          );
          ctxMenuEl.appendChild(
            menuItem(
              'delete',
              async () => {
                if (!confirm(`${entry.name} を削除しますか？`)) return;
                try {
                  await commands.deletePath(entry.path);
                } catch (err) {
                  alert(err?.message ?? String(err));
                }
              },
              { danger: true }
            )
          );
        }
        ctxMenuEl.appendChild(
          menuItem('property', async () => {
            await showProperty(entry, { x: lastCtxX, y: lastCtxY });
          })
        );

        ctxMenuEl.style.left = `${Math.max(6, e.clientX)}px`;
        ctxMenuEl.style.top = `${Math.max(6, e.clientY)}px`;
        ctxMenuEl.hidden = false;

        const rect = ctxMenuEl.getBoundingClientRect();
        let nx = e.clientX;
        let ny = e.clientY;
        if (rect.right > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - rect.width - 6);
        if (rect.bottom > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - rect.height - 6);
        ctxMenuEl.style.left = `${nx}px`;
        ctxMenuEl.style.top = `${ny}px`;
      };

      treeEl.appendChild(item);
    }
  }

  function bindControls() {
    // 画面上部のボタン類・ファイルアップロード・ルート切り替え等をバインド
    if (btnViewList) {
      btnViewList.onclick = () => {
        if (gridEl) gridEl.hidden = true;
        if (tableEl) tableEl.hidden = false;
        store.setState({ viewMode: 'list' });
      };
    }

    if (btnUpload) {
      // アップロードボタン: モーダルを開く
      btnUpload.onclick = () => {
        openUploadModal();
      };
    }

    btnUploadClose && (btnUploadClose.onclick = () => closeUploadModal());
    uploadModalBackdropEl && (uploadModalBackdropEl.onclick = () => closeUploadModal());

    if (btnUploadChoose && fileUpload) {
      // 「ファイルを選ぶ」ボタンで hidden の input をクリック
      btnUploadChoose.onclick = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        try {
          fileUpload.click();
        } catch {
          // ignore
        }
      };
    }

    if (uploadDropEl) {
      // ドロップエリアをクリックしてもファイル選択を開ける
      uploadDropEl.onclick = (e) => {
        const t = e?.target;
        const onButton = t?.closest ? t.closest('button') : null;
        if (onButton) return;
        try {
          fileUpload?.click?.();
        } catch {
          // ignore
        }
      };

      uploadDropEl.ondragover = (e) => {
        e.preventDefault();
        uploadDropEl.classList.add('is-dragover');
        try {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        } catch {
          // ignore
        }
      };
      uploadDropEl.ondragleave = (e) => {
        const rt = e?.relatedTarget;
        if (rt && uploadDropEl.contains(rt)) return;
        uploadDropEl.classList.remove('is-dragover');
      };
      uploadDropEl.ondrop = async (e) => {
        e.preventDefault();
        uploadDropEl.classList.remove('is-dragover');
        try {
          const snap = snapshotDrop(e.dataTransfer);
          const entries = await extractDroppedFiles(snap);
          if (!entries || entries.length === 0) return;
          await uploadDroppedEntries(entries);
          setStatus('');
          closeUploadModal();
        } catch (err) {
          alert(err?.message ?? String(err));
        }
      };
    }

    if (btnViewIcons) {
      btnViewIcons.onclick = () => {
        if (tableEl) tableEl.hidden = true;
        if (gridEl) gridEl.hidden = false;
        store.setState({ viewMode: 'icons' });
      };
    }

    btnUp.onclick = async () => {
      // 1つ上の階層へ
      const { cwd } = store.getState();
      const parent = cwd.split('/').filter(Boolean);
      parent.pop();
      try {
        await commands.navigate(parent.join('/'));
      } catch (e) {
        alert(e?.message ?? String(e));
      }
    };

    btnRefresh.onclick = async () => {
      // 右ペインの再読み込み
      try {
        setStatus('読み込み中...');
        await commands.refresh();
      } catch (e) {
        alert(e?.message ?? String(e));
      }
    };

    btnMkdir.onclick = async () => {
      // フォルダ作成: 入力行を出す
      createDraft = { kind: 'dir' };
      renameDraft = null;
      rerender();
    };

    btnTouch.onclick = async () => {
      // ファイル作成: 入力行を出す
      createDraft = { kind: 'file' };
      renameDraft = null;
      rerender();
    };

    if (btnDelete) {
      // 削除ボタン: 右ペインの複数選択に対して削除を実行
      btnDelete.onclick = async () => {
        const currentSelection = Array.from(selectedPaths);
        const count = currentSelection.length;
        if (count === 0) return;
        const label = count === 1 ? (currentSelection[0].split('/').filter(Boolean).pop() ?? currentSelection[0]) : `${count} items`;
        if (!confirm(`${label} を削除しますか？`)) return;
        try {
          if (count === 1) {
            await commands.deletePath(currentSelection[0]);
          } else {
            await commands.deletePaths(currentSelection);
          }
          selectedPaths = new Set();
          selectionAnchorIndex = null;
          rerender();
        } catch (e) {
          alert(e?.message ?? String(e));
        }
      };
    }

    fileUpload.onchange = async () => {
      // ファイルアップロード
      const files = Array.from(fileUpload.files ?? []);
      if (files.length === 0) return;
      try {
        await uploadFiles(files);
        fileUpload.value = '';
        setStatus('');
        closeUploadModal();
      } catch (e) {
        fileUpload.value = '';
        alert(e?.message ?? String(e));
      }
    };

    rootSelect.onchange = async () => {
      // ルート（roots）切り替え
      try {
        await commands.changeRoot(rootSelect.value);
        selectedPaths = new Set();
        selectionAnchorIndex = null;
      } catch (e) {
        alert(e?.message ?? String(e));
      }
    };

    if (panelEl) {
      // 右ペイン空白の右クリック: paste メニュー（貼り付け可能な場合のみ）
      panelEl.oncontextmenu = (e) => {
        const t = e?.target;
        const onTableRow = t?.closest ? t.closest('tr') : null;
        const onGridItem = t?.closest ? t.closest('.grid-item') : null;
        if (onTableRow || onGridItem) return;

        e?.preventDefault?.();
        e?.stopPropagation?.();
        hidePropertyModal();

        lastCtxX = e.clientX;
        lastCtxY = e.clientY;

        ctxMenuEl.innerHTML = '';
        if (canPaste()) {
          ctxMenuEl.appendChild(
            menuItem('paste', async () => {
              try {
                await doPaste();
              } catch (err) {
                alert(err?.message ?? String(err));
              }
            })
          );
        }
        if (ctxMenuEl.childNodes.length === 0) return;

        ctxMenuEl.style.left = `${Math.max(6, lastCtxX)}px`;
        ctxMenuEl.style.top = `${Math.max(6, lastCtxY)}px`;
        ctxMenuEl.hidden = false;

        const rect = ctxMenuEl.getBoundingClientRect();
        let nx = lastCtxX;
        let ny = lastCtxY;
        if (rect.right > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - rect.width - 6);
        if (rect.bottom > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - rect.height - 6);
        ctxMenuEl.style.left = `${nx}px`;
        ctxMenuEl.style.top = `${ny}px`;
      };
    }

    bindContentBackgroundDrop(contentEl);
    bindContentBackgroundDrop(tbody);
    bindContentBackgroundDrop(gridEl);
  }

  function render(state) {
    const contentEnabled = state.contentEnabled !== false;
    if (appRootEl) {
      appRootEl.classList.toggle('swefm-no-content', !contentEnabled);
    }
    if (contentEl) {
      contentEl.hidden = !contentEnabled;
    }

    if (breadcrumb) breadcrumb.hidden = !contentEnabled;
    if (panelEl) panelEl.hidden = !contentEnabled;
    if (statusEl) statusEl.hidden = !contentEnabled;

    renderBreadcrumb(state.breadcrumb);
    const mode = state.viewMode === 'icons' ? 'icons' : 'list';
    btnViewList?.classList.toggle('active', mode === 'list');
    btnViewIcons?.classList.toggle('active', mode === 'icons');
    btnViewList && (btnViewList.hidden = !contentEnabled);
    btnViewIcons && (btnViewIcons.hidden = !contentEnabled);
    rootSelect && (rootSelect.hidden = !contentEnabled);
    btnUp && (btnUp.hidden = !contentEnabled);
    btnRefresh && (btnRefresh.hidden = !contentEnabled);
    btnMkdir && (btnMkdir.hidden = !contentEnabled);
    btnTouch && (btnTouch.hidden = !contentEnabled);
    btnDelete && (btnDelete.hidden = !contentEnabled);
    btnUpload && (btnUpload.hidden = !contentEnabled);

    // 右ペインの選択が空の場合は削除ボタンを disabled
    if (btnDelete) btnDelete.disabled = selectedPaths.size === 0;

    if (!contentEnabled) {
      if (tableEl) tableEl.hidden = true;
      if (gridEl) gridEl.hidden = true;
    } else if (mode === 'icons') {
      if (tableEl) tableEl.hidden = true;
      if (gridEl) gridEl.hidden = false;
    } else {
      if (tableEl) tableEl.hidden = false;
      if (gridEl) gridEl.hidden = true;
    }

    if (contentEnabled) {
      if (mode === 'icons') {
        renderGrid(state.listing);
      } else {
        renderTable(state.listing);
      }
    }
    renderTree(state.cwd);
    setStatus(`root: ${state.currentRoot}  path: /${state.cwd}`);
  }

  bindControls();
  store.subscribe(render);
  render(store.getState());
}
