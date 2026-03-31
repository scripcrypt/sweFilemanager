// 旧版（レガシー）の単体実装。
// 現在の本体は `public/main.js` + `public/core/*` + `public/views/vscodeExplorerView.js`。
//
// NOTE:
// - このファイルは store/commands/view の分離が入る前の実装で、参考用途/比較用途。
// - 実行されるのは index.html から読み込んだ場合のみ（現状は main.js を読む構成）。

// DOM 参照（右ペイン/左ツリー/ステータス）
const tbody = document.getElementById('tbody');
const breadcrumb = document.getElementById('breadcrumb');
const statusEl = document.getElementById('status');
const treeEl = document.getElementById('tree');

const btnUp = document.getElementById('btn-up');
const btnRefresh = document.getElementById('btn-refresh');
const btnMkdir = document.getElementById('btn-mkdir');
const btnTouch = document.getElementById('btn-touch');
const fileUpload = document.getElementById('file-upload');
const rootSelect = document.getElementById('root-select');

// 現在のディレクトリ（root からの相対）と、選択ルート
let currentPath = '';
let currentRoot = '';

// 左ツリー用の簡易キャッシュ
const treeState = new Map();

function getDirName(p) {
  // `a/b/c` -> `c`
  if (!p) return '/';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '/';
}

function depthOf(p) {
  // パスの深さ（ツリーのインデント用）
  return p ? p.split('/').filter(Boolean).length : 0;
}

function hasLoaded(p) {
  // ツリーキャッシュが読み込み済みか
  return treeState.get(p)?.loaded === true;
}

function setNodeState(p, patch) {
  // ツリーキャッシュの更新（浅いマージ）
  const prev = treeState.get(p) ?? { loaded: false, expanded: false, dirs: [] };
  treeState.set(p, { ...prev, ...patch });
}

function fmtBytes(n) {
  // バイト数の見やすい表示
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
  // epoch ms -> ローカル日時
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString();
}

function setStatus(text) {
  // ステータス欄更新
  statusEl.textContent = text;
}

function joinPath(base, name) {
  // `base` と `name` を / で結合（簡易）
  if (!base) return name;
  return `${base.replace(/\/+$/g, '')}/${name.replace(/^\/+/, '')}`;
}

function parentPath(p) {
  // `a/b/c` -> `a/b`
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

async function apiJson(url, init) {
  // fetch を JSON 前提でラップ（エラー時は Error を投げる）
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function apiUrl(action, params = {}) {
  // PHP API（public/api.php）への URL を組み立てる
  const u = new URL('./public/api.php', window.location.href);
  u.searchParams.set('action', action);
  if (currentRoot) u.searchParams.set('root', currentRoot);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v ?? '');
  }
  return u.toString();
}

async function loadConfig() {
  // config を読み、root-select を構築
  const u = new URL('./public/api.php', window.location.href);
  u.searchParams.set('action', 'config');
  const cfg = await apiJson(u.toString());

  const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
  rootSelect.innerHTML = '';

  for (const r of roots) {
    if (!r || typeof r.key !== 'string') continue;
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = typeof r.label === 'string' ? r.label : r.key;
    rootSelect.appendChild(opt);
  }

  const defaultRoot = typeof cfg.defaultRoot === 'string' ? cfg.defaultRoot : (roots[0]?.key ?? '');
  currentRoot = defaultRoot;
  rootSelect.value = defaultRoot;

  rootSelect.onchange = async () => {
    currentRoot = rootSelect.value;
    treeState.clear();
    currentPath = '';
    await navigate('');
  };
}

async function loadDirs(p) {
  // ツリー用: ディレクトリ一覧をロードしてキャッシュ
  if (hasLoaded(p)) return;
  const data = await apiJson(apiUrl('list', { path: p }));
  const dirs = (data.entries ?? []).filter((e) => e.isDir).map((e) => ({ name: e.name, path: e.path }));
  setNodeState(p, { loaded: true, dirs });
}

function renderTree() {
  // 左ツリー描画
  const selected = currentPath;
  treeEl.innerHTML = '';

  const rows = [];

  function pushNode(p) {
    // 展開状態に応じて可視ノードを列挙
    const st = treeState.get(p) ?? { loaded: false, expanded: false, dirs: [] };
    const depth = depthOf(p);
    rows.push({ p, st, depth });
    if (st.expanded) {
      for (const child of st.dirs) {
        pushNode(child.path);
      }
    }
  }

  if (!treeState.has('')) {
    setNodeState('', { loaded: false, expanded: true, dirs: [] });
  }

  pushNode('');

  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-selected', row.p === selected ? 'true' : 'false');

    for (let i = 0; i < row.depth; i += 1) {
      const ind = document.createElement('span');
      ind.className = 'tree-indent';
      item.appendChild(ind);
    }

    const twist = document.createElement('span');
    twist.className = 'tree-twist';
    const canExpand = !row.st.loaded || row.st.dirs.length > 0;
    twist.textContent = canExpand ? (row.st.expanded ? '▾' : '▸') : '';
    twist.onclick = async (e) => {
      e.stopPropagation();
      if (!canExpand) return;
      try {
        if (!row.st.loaded) {
          await loadDirs(row.p);
          setNodeState(row.p, { expanded: true });
        } else {
          setNodeState(row.p, { expanded: !row.st.expanded });
        }
        renderTree();
      } catch (err) {
        alert(err?.message ?? String(err));
      }
    };
    item.appendChild(twist);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = getDirName(row.p);
    item.appendChild(label);

    item.onclick = async () => {
      await navigate(row.p);
    };

    treeEl.appendChild(item);
  }
}

async function ensureTreePathVisible(p) {
  // 現在パスがツリー上で見えるように、親を順にロード/展開
  const parts = p.split('/').filter(Boolean);
  let acc = '';
  setNodeState('', { expanded: true });
  for (let i = 0; i < parts.length; i += 1) {
    const next = acc ? `${acc}/${parts[i]}` : parts[i];
    await loadDirs(acc);
    setNodeState(acc, { expanded: true });
    acc = next;
  }
  if (acc !== '') {
    await loadDirs(acc);
  }
}

function renderBreadcrumb(p) {
  // パンくず描画
  const parts = p.split('/').filter(Boolean);
  const segs = [''];
  for (const part of parts) {
    const prev = segs[segs.length - 1];
    segs.push(joinPath(prev, part));
  }

  breadcrumb.innerHTML = '';
  const rootLink = document.createElement('a');
  rootLink.href = '#';
  rootLink.textContent = '/';
  rootLink.onclick = (e) => {
    e.preventDefault();
    navigate('');
  };
  breadcrumb.appendChild(rootLink);

  for (let i = 1; i < segs.length; i += 1) {
    const sep = document.createTextNode(' / ');
    breadcrumb.appendChild(sep);

    const a = document.createElement('a');
    a.href = '#';
    a.textContent = parts[i - 1];
    const target = segs[i];
    a.onclick = (e) => {
      e.preventDefault();
      navigate(target);
    };
    breadcrumb.appendChild(a);
  }
}

function rowActionButton(label, onClick, { danger = false } = {}) {
  // 右ペインの操作ボタン（旧版）
  const btn = document.createElement('button');
  btn.textContent = label;
  if (danger) btn.classList.add('danger');
  btn.onclick = onClick;
  return btn;
}

async function refresh() {
  // 右ペイン一覧を更新
  setStatus('読み込み中...');
  const data = await apiJson(apiUrl('list', { path: currentPath }));
  renderBreadcrumb(data.path);

  tbody.innerHTML = '';

  for (const entry of data.entries) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const nameWrap = document.createElement('span');
    nameWrap.className = 'name';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = entry.isDir ? 'DIR' : 'FILE';

    const a = document.createElement('a');
    a.href = '#';
    a.className = 'link';
    a.textContent = entry.name;
    a.onclick = (e) => {
      e.preventDefault();
      if (entry.isDir) {
        navigate(entry.path);
      } else {
        window.location.href = apiUrl('download', { path: entry.path });
      }
    };

    nameWrap.appendChild(badge);
    nameWrap.appendChild(a);
    tdName.appendChild(nameWrap);

    const tdSize = document.createElement('td');
    tdSize.textContent = entry.isDir ? '' : fmtBytes(entry.size);

    const tdMtime = document.createElement('td');
    tdMtime.textContent = fmtTime(entry.mtimeMs);

    const tdActions = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';

    actions.appendChild(
      rowActionButton('名前変更', async () => {
        const newName = prompt('新しい名前');
        if (!newName) return;
        await apiJson(apiUrl('rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entry.path, newName }),
        });
        await refresh();
      })
    );

    if (!entry.isDir) {
      actions.appendChild(
        rowActionButton('DL', () => {
          window.location.href = apiUrl('download', { path: entry.path });
        })
      );
    }

    actions.appendChild(
      rowActionButton(
        '削除',
        async () => {
          if (!confirm(`${entry.name} を削除しますか？`)) return;
          await apiJson(apiUrl('delete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: entry.path }),
          });
          await refresh();
        },
        { danger: true }
      )
    );

    tdActions.appendChild(actions);

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdMtime);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  setStatus(`path: /${currentPath}`);
}

async function navigate(p) {
  // ディレクトリ移動（ツリーの展開/右ペイン更新）
  currentPath = (p ?? '').toString();
  if (!hasLoaded('')) {
    await loadDirs('');
  }
  await ensureTreePathVisible(currentPath);
  renderTree();
  await refresh();
}

btnUp.onclick = async () => {
  // 上へ
  await navigate(parentPath(currentPath));
};

btnRefresh.onclick = async () => {
  // 更新
  await refresh();
};

btnMkdir.onclick = async () => {
  // フォルダ作成（prompt）
  const name = prompt('フォルダ名');
  if (!name) return;
  await apiJson(apiUrl('mkdir'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, name }),
  });
  await refresh();
};

btnTouch.onclick = async () => {
  // ファイル作成（prompt）
  const name = prompt('ファイル名');
  if (!name) return;
  await apiJson(apiUrl('touch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentPath, name }),
  });
  await refresh();
};

fileUpload.onchange = async () => {
  // アップロード（multipart）
  const file = fileUpload.files?.[0];
  if (!file) return;
  try {
    setStatus('アップロード中...');
    const fd = new FormData();
    fd.append('file', file);
    await apiJson(apiUrl('upload', { path: currentPath }), {
      method: 'POST',
      body: fd,
    });
    fileUpload.value = '';
    await refresh();
  } catch (e) {
    fileUpload.value = '';
    alert(e?.message ?? String(e));
    setStatus('');
  }
};

loadConfig()
  // 起動（設定ロード -> ルートへ移動）
  .then(() => navigate(''))
  .catch((e) => {
    alert(e?.message ?? String(e));
  });
