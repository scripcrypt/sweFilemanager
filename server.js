import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import mime from 'mime-types';
import multer from 'multer';

// 開発・ローカル検証用の Node サーバ。
// 本番では PHP 版（public/api.php）を使う想定。
//
// 環境変数:
// - PORT: listen port（デフォルト 5173）
// - FILE_ROOT: 操作ルート（デフォルト: ./data）
const app = express();

const PORT = Number.parseInt(process.env.PORT ?? '5173', 10);
const FILE_ROOT = path.resolve(process.env.FILE_ROOT ?? path.join(process.cwd(), 'data'));

// 操作ルートを確実に作成
await fsp.mkdir(FILE_ROOT, { recursive: true });

app.use(express.json({ limit: '2mb' }));
// public/ を静的配信（フロントエンド）
app.use(express.static(path.join(process.cwd(), 'public')));

function safeResolve(relativePath) {
  // 受け取った相対パスを FILE_ROOT 配下に閉じ込めて絶対パスに解決する。
  // `..` などで脱出しようとした場合は 400 エラーにする。
  const decoded = typeof relativePath === 'string' ? relativePath : '';
  const cleaned = decoded.replaceAll('\\', '/');
  const resolved = path.resolve(FILE_ROOT, cleaned);
  const rootWithSep = FILE_ROOT.endsWith(path.sep) ? FILE_ROOT : FILE_ROOT + path.sep;
  if (resolved !== FILE_ROOT && !resolved.startsWith(rootWithSep)) {
    const err = new Error('Path outside root');
    err.status = 400;
    throw err;
  }
  return resolved;
}

function toRelative(absPath) {
  // FILE_ROOT からの相対パスへ変換（/ 区切り）
  const rel = path.relative(FILE_ROOT, absPath);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

async function statEntry(absPath) {
  // API で返す entry 形式へ変換
  const st = await fsp.stat(absPath);
  return {
    name: path.basename(absPath),
    path: toRelative(absPath),
    isDir: st.isDirectory(),
    size: st.isFile() ? st.size : null,
    mtimeMs: st.mtimeMs,
  };
}

app.get('/api/config', (req, res) => {
  // PHP版の config と違い、簡易的に root を返すだけ
  res.json({ root: '' });
});

app.get('/api/list', async (req, res, next) => {
  // ディレクトリ一覧
  try {
    const rel = (req.query.path ?? '').toString();
    const abs = safeResolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) {
      return res.status(400).json({ error: 'Not a directory' });
    }
    const names = await fsp.readdir(abs);
    const entries = await Promise.all(
      names.map(async (n) => {
        const p = path.join(abs, n);
        return statEntry(p);
      })
    );

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: toRelative(abs), entries });
  } catch (e) {
    next(e);
  }
});

app.post('/api/mkdir', async (req, res, next) => {
  // フォルダ作成
  try {
    const dir = (req.body?.path ?? '').toString();
    const name = (req.body?.name ?? '').toString();
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const parentAbs = safeResolve(dir);
    const targetAbs = safeResolve(path.posix.join(dir.split('\\').join('/'), name));
    if (path.dirname(targetAbs) !== parentAbs) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    await fsp.mkdir(targetAbs, { recursive: false });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post('/api/touch', async (req, res, next) => {
  // 空ファイル作成
  try {
    const dir = (req.body?.path ?? '').toString();
    const name = (req.body?.name ?? '').toString();
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const parentAbs = safeResolve(dir);
    const targetAbs = safeResolve(path.posix.join(dir.split('\\').join('/'), name));
    if (path.dirname(targetAbs) !== parentAbs) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    const fh = await fsp.open(targetAbs, 'wx');
    await fh.close();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post('/api/rename', async (req, res, next) => {
  // リネーム
  try {
    const rel = (req.body?.path ?? '').toString();
    const newName = (req.body?.newName ?? '').toString();
    if (!newName) return res.status(400).json({ error: 'Missing newName' });

    const abs = safeResolve(rel);
    const parentAbs = path.dirname(abs);
    const targetAbs = safeResolve(path.posix.join(toRelative(parentAbs), newName));
    if (path.dirname(targetAbs) !== parentAbs) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    await fsp.rename(abs, targetAbs);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

async function rmRecursive(absPath) {
  // ディレクトリ/ファイル削除（再帰）
  const st = await fsp.lstat(absPath);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    const items = await fsp.readdir(absPath);
    await Promise.all(items.map((n) => rmRecursive(path.join(absPath, n))));
    await fsp.rmdir(absPath);
  } else {
    await fsp.unlink(absPath);
  }
}

app.delete('/api/delete', async (req, res, next) => {
  // 削除
  try {
    const rel = (req.query.path ?? '').toString();
    if (rel === '') return res.status(400).json({ error: 'Refuse to delete root' });
    const abs = safeResolve(rel);
    await rmRecursive(abs);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

const upload = multer({
  // ファイルアップロード（multipart）
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const relDir = (req.query.path ?? '').toString();
        const absDir = safeResolve(relDir);
        const st = await fsp.stat(absDir);
        if (!st.isDirectory()) return cb(new Error('Not a directory'), FILE_ROOT);
        cb(null, absDir);
      } catch (e) {
        cb(e, FILE_ROOT);
      }
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 200 },
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  // アップロード成功（詳細は返さない）
  res.json({ ok: true });
});

app.get('/api/download', async (req, res, next) => {
  // ダウンロード
  try {
    const rel = (req.query.path ?? '').toString();
    if (!rel) return res.status(400).json({ error: 'Missing path' });
    const abs = safeResolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });

    const contentType = mime.contentType(path.extname(abs)) || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);

    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    next(e);
  }
});

app.use((err, req, res, next) => {
  // エラーハンドラ（JSON で返す）
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({ error: err?.message ?? 'Internal error' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  // 起動ログ
  // eslint-disable-next-line no-console
  console.log(`Remote file manager: http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`FILE_ROOT: ${FILE_ROOT}`);
});
