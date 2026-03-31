export function joinPath(base, name) {
  // `base`（ディレクトリ）と `name`（子要素名）を「/」区切りで結合する。
  // - 余計なスラッシュを取り除く
  // - 先頭/末尾のスラッシュが混ざっても正規化する
  if (!base) return name;
  return `${base.replace(/\/+$/g, '')}/${name.replace(/^\/+/, '')}`;
}

export function parentPath(p) {
  // `a/b/c` -> `a/b`
  // ルート（空文字）の場合は空文字を返す。
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function depthOf(p) {
  // ツリー描画用: パスの深さ（セグメント数）を返す。
  return p ? p.split('/').filter(Boolean).length : 0;
}

export function getDirName(p) {
  // `a/b/c` -> `c`
  // ルート（空文字）の場合は `/` 表記にする。
  if (!p) return '/';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '/';
}
