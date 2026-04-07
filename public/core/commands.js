export function createCommands({ api, store }) {
  // UI から呼ばれる「操作（コマンド）」をまとめた層。
  // - API 呼び出し（public/core/api.js）を行う
  // - 結果を store に反映し、UI（View）に再描画させる
  // - 左ツリー表示のためのディレクトリキャッシュ（treeState）もここで管理する
  const treeState = new Map();

  function parentPath(p) {
    // `a/b/c` -> `a/b`（パス操作用）
    if (!p) return '';
    const parts = p.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function hasLoaded(p) {
    // ツリーキャッシュに「読み込み済み」フラグが立っているか
    return treeState.get(p)?.loaded === true;
  }

  function setNodeState(p, patch) {
    // ツリーキャッシュのノード状態を更新する。
    // - loaded: children が取得済みか
    // - expanded: ツリー上で展開されているか
    // - dirs/children: 子要素一覧（ディレクトリだけ / 全要素）
    const prev = treeState.get(p) ?? { loaded: false, expanded: false, dirs: [], children: [] };
    treeState.set(p, { ...prev, ...patch });
  }

  async function loadDirs(p) {
    // 指定ディレクトリの children を API から取得して treeState にキャッシュする。
    // 既に loaded の場合は何もしない。
    if (hasLoaded(p)) return;
    const { currentRoot } = store.getState();
    const data = await api.list({ root: currentRoot, path: p });
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const dirs = entries.filter((e) => e.isDir).map((e) => ({ name: e.name, path: e.path, isDir: true }));
    const files = entries.filter((e) => !e.isDir).map((e) => ({ name: e.name, path: e.path, isDir: false }));
    const children = [...dirs, ...files];
    setNodeState(p, { loaded: true, dirs, children });
  }

  async function ensureTreePathVisible(p) {
    // あるパスに到達するまでに必要な親ディレクトリを順に読み込み、ツリー上で展開状態にする。
    // 例: `a/b/c` の場合
    // - ''（root）
    // - 'a'
    // - 'a/b'
    // を順に loadDirs / expanded して、ツリーで見える状態にする。
    const parts = (p ?? '').split('/').filter(Boolean);
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

  async function refresh() {
    // 右ペイン（一覧）の最新化。
    // - 現在の cwd を list して listing/breadcrumb を store に反映
    const { currentRoot, cwd } = store.getState();
    const data = await api.list({ root: currentRoot, path: cwd });
    store.setState({ listing: data.entries ?? [], breadcrumb: data.path ?? '' });
  }

  async function navigate(path) {
    // ディレクトリ移動。
    // 1) store.cwd を更新
    // 2) ツリーの root を確実に loaded にする
    // 3) 目的パスがツリー上に見えるように親を読み込み/展開
    // 4) 目的ディレクトリ自体も読み込んで expanded
    // 5) ツリー状態（treeState）を store に入れて UI を更新
    // 6) 右ペインの一覧を refresh
    store.setState({ cwd: (path ?? '').toString() });
    if (!hasLoaded('')) {
      await loadDirs('');
    }
    await ensureTreePathVisible(store.getState().cwd);
    await loadDirs(store.getState().cwd);
    setNodeState(store.getState().cwd, { expanded: true });
    store.setState({ treeState });
    await refresh();
  }

  async function openDir(path) {
    // 右ペインだけを指定ディレクトリに切り替える。
    // - ツリーは自動展開しない（シングルクリックでツリーが開いてしまうのを防ぐ）
    store.setState({ cwd: (path ?? '').toString() });
    await refresh();
  }

  async function copyPaths(destDir, paths) {
    // 複数パスのコピー。
    // - サーバ側で再帰コピー（ディレクトリも対象）
    // - コピー元/先が含まれるディレクトリを reload してツリーと一覧を整合させる
    const { currentRoot, cwd } = store.getState();
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (list.length === 0) return;
    await api.copy({ root: currentRoot, destDir: destDir ?? '', paths: list });

    const toReload = new Set();
    toReload.add(destDir ?? '');
    await reloadDir(cwd, { expand: true });
    for (const d of toReload) {
      await reloadDir(d, { expand: true });
    }
    await refresh();
  }

  async function changeRoot(rootKey) {
    // ルート切り替え。
    // - ツリーキャッシュを破棄して 0 から作り直す
    // - cwd/listing/breadcrumb も初期化
    treeState.clear();
    store.setState({ currentRoot: rootKey, cwd: '', listing: [], breadcrumb: '' });
    await navigate('');
  }

  async function createFolder(name) {
    // フォルダ作成（cwd 配下）
    const { currentRoot, cwd } = store.getState();
    await api.mkdir({ root: currentRoot, path: cwd, name });
    await reloadDir(cwd, { expand: true });
    await refresh();
  }

  async function createFile(name) {
    // 空ファイル作成（cwd 配下）
    const { currentRoot, cwd } = store.getState();
    await api.touch({ root: currentRoot, path: cwd, name });
    await reloadDir(cwd, { expand: true });
    await refresh();
  }

  async function renamePath(path, newName) {
    // リネーム。
    // - 親ディレクトリを reload し、表示を更新する
    const { currentRoot } = store.getState();
    await api.rename({ root: currentRoot, path, newName });
    await reloadDir(parentPath(path), { expand: true });
    await refresh();
  }

  async function deletePath(path) {
    // 単体削除。
    // - 親ディレクトリを reload し、表示を更新する
    const { currentRoot } = store.getState();
    await api.remove({ root: currentRoot, path });
    await reloadDir(parentPath(path), { expand: true });
    await refresh();
  }

  async function deletePaths(paths) {
    // 複数削除。
    // - 1件ずつ削除（APIは単体delete）
    // - 影響する親ディレクトリをまとめて reload
    const { currentRoot, cwd } = store.getState();
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (list.length === 0) return;

    for (const p of list) {
      await api.remove({ root: currentRoot, path: p });
    }

    const toReload = new Set();
    for (const p of list) {
      toReload.add(parentPath(p));
    }
    for (const d of toReload) {
      await reloadDir(d, { expand: true });
    }
    await reloadDir(cwd, { expand: true });
    await refresh();
  }

  async function movePaths(destDir, paths) {
    // 複数パスの移動。
    // - 移動元/先の親ディレクトリを reload し、ツリーと一覧を整合させる
    const { currentRoot, cwd } = store.getState();
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (list.length === 0) return;
    await api.move({ root: currentRoot, destDir: destDir ?? '', paths: list });

    const toReload = new Set();
    toReload.add(destDir ?? '');
    for (const p of list) {
      toReload.add(parentPath(p));
    }
    for (const d of toReload) {
      await reloadDir(d, { expand: true });
    }
    await reloadDir(cwd, { expand: true });
    await refresh();
  }

  async function uploadFile(file) {
    // アップロード。
    // - 成功後に cwd を reload/refresh
    const { currentRoot, cwd } = store.getState();
    await api.upload({ root: currentRoot, path: cwd, file });
    await reloadDir(cwd, { expand: true });
    await refresh();
  }

  async function ensureDirExists(dirPath) {
    // 指定パス（cwd からの相対）に必要なディレクトリを順に作成する。
    // - 既に存在する場合はエラーになることがあるので握りつぶす
    // - 空文字はルート（cwd）扱い
    const { currentRoot, cwd } = store.getState();
    const p = (dirPath ?? '').toString().replace(/\\/g, '/');
    const parts = p.split('/').filter(Boolean);
    let acc = '';
    for (const name of parts) {
      acc = acc ? `${acc}/${name}` : name;
      try {
        const parentRel = parentPath(acc);
        const base = cwd ?? '';
        const mkdirPath = parentRel ? `${base}/${parentRel}` : base;
        await api.mkdir({ root: currentRoot, path: mkdirPath.replace(/\/+?/g, '/').replace(/^\/+/, ''), name });
      } catch {
        // ignore
      }
    }
  }

  async function uploadFileTo(destDir, file, { reload = true } = {}) {
    // 指定ディレクトリへアップロードする。
    // - destDir は cwd からの相対（'' 可）
    // - reload=true の場合のみ cwd を reload/refresh（大量アップロード時は false 推奨）
    const { currentRoot, cwd } = store.getState();
    const dir = (destDir ?? '').toString();
    const raw = dir ? `${cwd ?? ''}/${dir}` : (cwd ?? '');
    const uploadPath = raw.replace(/\/+?/g, '/').replace(/^\/+/, '');
    await api.upload({ root: currentRoot, path: uploadPath, file });
    if (reload) {
      await reloadDir(cwd, { expand: true });
      await refresh();
    }
  }

  async function statPath(path) {
    // プロパティ表示用の stat
    const { currentRoot } = store.getState();
    return api.stat({ root: currentRoot, path });
  }

  function download(path) {
    // ダウンロードはブラウザ遷移で行う（バイナリ返却のため）
    const { currentRoot } = store.getState();
    window.location.href = api.downloadUrl({ root: currentRoot, path });
  }

  function getDownloadUrl(path) {
    // UI 側が直接 fetch したい場合などに使う
    const { currentRoot } = store.getState();
    return api.downloadUrl({ root: currentRoot, path });
  }

  function getTreeState() {
    // View から参照するために treeState を返す
    return treeState;
  }

  async function reloadDir(p, { expand = false } = {}) {
    // ツリーキャッシュの指定ディレクトリを「読み直し」する。
    // - loaded を false に戻してから loadDirs する
    // - expand=true の場合は強制的に expanded にする
    const prev = treeState.get(p);
    const expanded = expand ? true : prev?.expanded === true;
    treeState.set(p, { loaded: false, expanded, dirs: [], children: [] });
    await loadDirs(p);
  }

  return {
    navigate,
    openDir,
    refresh,
    changeRoot,
    createFolder,
    createFile,
    renamePath,
    deletePath,
    deletePaths,
    movePaths,
    copyPaths,
    uploadFile,
    uploadFileTo,
    ensureDirExists,
    statPath,
    download,
    getDownloadUrl,
    loadDirs,
    setNodeState,
    getTreeState,
    reloadDir,
  };
}
