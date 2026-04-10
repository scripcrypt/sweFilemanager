// CSRF トークン（サーバが JSON に同梱して返してくる `csrftk`）
// 書き込み系リクエスト（POST 等）に `X-CSRF-Token` として付与する。
let csrfToken = '';

function mergeHeaders(a, b) {
  // Headers をマージして新しい Headers を返す。
  // - `a` と `b` の順で上書きする（b が優先）
  const out = new Headers();
  const ha = a instanceof Headers ? a : new Headers(a ?? {});
  const hb = b instanceof Headers ? b : new Headers(b ?? {});
  for (const [k, v] of ha.entries()) out.set(k, v);
  for (const [k, v] of hb.entries()) out.set(k, v);
  return out;
}

async function apiJson(url, init) {
  // fetch を JSON 前提でラップする。
  // - サーバから返される `csrftk` を保存して次回以降に利用
  // - 失敗時はレスポンス本文（JSONのerror or text）を含む Error を投げる
  const method = (init?.method ?? 'GET').toString().toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const headers = mergeHeaders(init?.headers, isWrite && csrfToken ? { 'X-CSRF-Token': csrfToken } : null);

  const res = await fetch(url, {
    ...(init ?? {}),
    headers,
    credentials: 'same-origin',
  });
  const text = await res.text().catch(() => '');
  // JSON が返ってこないケースもあるため、まず text として読む。
  // JSON であればパースし、ダメなら空オブジェクトにする。
  const data = (() => {
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  })();

  if (data && typeof data === 'object' && typeof data.csrftk === 'string' && data.csrftk) {
    // サーバ側が csrftk を返したら更新
    csrfToken = data.csrftk;
  }

  if (!res.ok) {
    // サーバが JSON を返せない場合も含め、できるだけ人間が読めるメッセージにする
    const msg = data?.error || (text ? text.slice(0, 500) : '') || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

export function createApi({ baseUrl, rootPath }) {
  // API クライアント。
  // - `baseUrl` は `public/api.php` を想定（`action=` で分岐）
  // - `rootPath` が指定された場合、全リクエストに付与して config.json のパスを上書きする
  const base = new URL(baseUrl ?? './public/api.php', window.location.href);

  function apiUrl(action, { root, ...params } = {}) {
    // `action` とクエリパラメータから URL を構築する。
    // 例: api.php?action=list&root=demo&path=a/b
    const u = new URL(base);
    u.searchParams.set('action', action);
    if (root) u.searchParams.set('root', root);
    if (rootPath) u.searchParams.set('rootPath', rootPath);
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async function getConfig() {
    // UI 初期化に必要な設定（roots/content/icons など）を取得
    return apiJson(apiUrl('config'));
  }

  async function list({ root, path }) {
    // ディレクトリ一覧を取得
    return apiJson(apiUrl('list', { root, path: path ?? '' }));
  }

  async function stat({ root, path }) {
    // ファイル/フォルダの詳細（owner/mode 等）を取得
    return apiJson(apiUrl('stat', { root, path: path ?? '' }));
  }

  async function mkdir({ root, path, name }) {
    // ディレクトリ作成
    return apiJson(apiUrl('mkdir', { root }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path ?? '', name }),
    });
  }

  async function touch({ root, path, name }) {
    // 空ファイル作成
    return apiJson(apiUrl('touch', { root }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path ?? '', name }),
    });
  }

  async function rename({ root, path, newName }) {
    // リネーム
    return apiJson(apiUrl('rename', { root }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, newName }),
    });
  }

  async function remove({ root, path }) {
    // 削除（ファイル/フォルダ）
    return apiJson(apiUrl('delete', { root }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  }

  async function move({ root, destDir, paths }) {
    // 移動（複数パス）
    return apiJson(apiUrl('move', { root }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destDir: destDir ?? '', paths: Array.isArray(paths) ? paths : [] }),
    });
  }

  async function copy({ root, destDir, paths }) {
    // コピー（複数パス）
    return apiJson(apiUrl('copy', { root }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destDir: destDir ?? '', paths: Array.isArray(paths) ? paths : [] }),
    });
  }

  async function upload({ root, path, file }) {
    // アップロード（multipart/form-data）
    const fd = new FormData();
    fd.append('file', file);
    return apiJson(apiUrl('upload', { root, path: path ?? '' }), {
      method: 'POST',
      body: fd,
    });
  }

  function downloadUrl({ root, path }) {
    // ダウンロード URL を生成（この action は JSON ではなくバイナリを返す）
    return apiUrl('download', { root, path });
  }

  return { getConfig, list, stat, mkdir, touch, rename, remove, move, copy, upload, downloadUrl };
}
