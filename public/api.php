<?php

declare(strict_types=1);

// セキュリティ: MIME sniffing を抑止
header('X-Content-Type-Options: nosniff');

// CSRF トークンをセッションに保持するため session を開始
session_start();

function csrf_token(): string {
    // セッション内に CSRF トークンが無ければ生成して返す
    if (!isset($_SESSION['csrf']) || !is_string($_SESSION['csrf']) || $_SESSION['csrf'] === '') {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return (string)$_SESSION['csrf'];
}

function copy_recursive(string $src, string $dst): void {
    // 再帰コピー（ディレクトリも対象）
    // - シンボリックリンクはセキュリティ上コピー禁止
    // - ファイルは copy()
    // - ディレクトリは mkdir + scandir で子要素を再帰
    if (is_link($src)) {
        throw new RuntimeException('Symlink copy is not supported', 400);
    }
    if (is_file($src)) {
        if (!@copy($src, $dst)) {
            $last = error_get_last();
            $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to copy file';
            throw new RuntimeException($msg, 500);
        }
        return;
    }
    if (is_dir($src)) {
        if (!is_dir($dst)) {
            if (!@mkdir($dst, 0775, false)) {
                $last = error_get_last();
                $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to create directory';
                throw new RuntimeException($msg, 500);
            }
        }
        $items = scandir($src);
        if ($items === false) {
            throw new RuntimeException('Failed to read directory', 500);
        }
        foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            copy_recursive($src . DIRECTORY_SEPARATOR . $it, $dst . DIRECTORY_SEPARATOR . $it);
        }
        return;
    }
    throw new RuntimeException('Not found', 404);
}

function require_csrf(): void {
    // 書き込み系リクエストで CSRF を検証する。
    // - フロントは `X-CSRF-Token` ヘッダで送る
    // - トークンは JSON 応答の `csrftk` として配布され、フロントが保存する
    $sent = '';
    if (isset($_SERVER['HTTP_X_CSRF_TOKEN']) && is_string($_SERVER['HTTP_X_CSRF_TOKEN'])) {
        $sent = (string)$_SERVER['HTTP_X_CSRF_TOKEN'];
    }
    if ($sent === '' || !hash_equals(csrf_token(), $sent)) {
        throw new RuntimeException('CSRF token mismatch', 403);
    }
}

function load_config(): array {
    // プロジェクト直下の config.json を読み込む。
    // 無い場合はデフォルト設定（data ディレクトリ）にする。
    $cfgPath = realpath(__DIR__ . '/../config.json');
    if ($cfgPath === false) {
        return [
            'defaultRoot' => 'data',
            'roots' => [
                'data' => [
                    'label' => 'data (project)',
                    'path' => './data',
                ],
            ],
        ];
    }

    $raw = file_get_contents($cfgPath);
    $decoded = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($decoded)) {
        throw new RuntimeException('Invalid config.json');
    }
    if (!isset($decoded['roots']) || !is_array($decoded['roots'])) {
        throw new RuntimeException('Invalid config.json (roots)');
    }
    if (!isset($decoded['defaultRoot']) || !is_string($decoded['defaultRoot'])) {
        $decoded['defaultRoot'] = array_key_first($decoded['roots']);
    }
    return $decoded;
}

function resolve_root(array $cfg, string $rootKey): string {
    // `root` パラメータ（キー）から、実際のファイルシステム上の絶対パスを解決する。
    // - 未指定なら defaultRoot
    // - 相対パス指定の場合は「このプロジェクトからの相対」にする
    // - root が存在しなければ作成を試みる
    if ($rootKey === '') {
        $rootKey = (string)$cfg['defaultRoot'];
    }
    if (!isset($cfg['roots'][$rootKey]) || !is_array($cfg['roots'][$rootKey])) {
        $keys = [];
        if (isset($cfg['roots']) && is_array($cfg['roots'])) {
            $keys = array_keys($cfg['roots']);
        }
        throw new RuntimeException('Unknown root: ' . $rootKey . ' (available: ' . implode(', ', $keys) . ')');
    }
    $rootDef = $cfg['roots'][$rootKey];
    $relPath = isset($rootDef['path']) && is_string($rootDef['path']) ? $rootDef['path'] : '';
    if ($relPath === '') {
        throw new RuntimeException('Invalid root path');
    }

    $abs = $relPath;
    if (!preg_match('#^/|^[A-Za-z]:\\\\#', $relPath)) {
        $abs = __DIR__ . '/../' . $relPath;
    }

    $rp = realpath($abs);
    if ($rp === false) {
        if (!is_dir($abs)) {
            if (!@mkdir($abs, 0775, true)) {
                $last = error_get_last();
                $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to create root directory';
                throw new RuntimeException($msg);
            }
        }
        clearstatcache(true, $abs);
        $rp = realpath($abs);
    }

    if ($rp === false && is_dir($abs)) {
        $parent = dirname($abs);
        $parentRp = realpath($parent);
        if ($parentRp !== false) {
            $rp = rtrim($parentRp, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . basename($abs);
        }
    }

    if ($rp === false) {
        $last = error_get_last();
        $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to initialize root';
        throw new RuntimeException($msg . ' (' . $abs . ')');
    }
    return $rp;
}

function json_response(int $code, array $data): void {
    // JSON 応答の共通関数。
    // - HTTP ステータスを設定
    // - Content-Type を JSON にする
    // - 常に `csrftk` を付与（フロントが保存し、書き込み系で送る）
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    if (!isset($data['csrftk'])) {
        $data['csrftk'] = csrf_token();
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function normalize_rel(string $p): string {
    // 相対パスの正規化。
    // - `\` を `/` に統一
    // - 連続スラッシュを潰す
    // - 先頭の `/` を除去し「相対パス」に限定
    // - `.` を除去、`..` は一段上へ（ただしルートを超えたらエラー）
    $p = str_replace('\\', '/', $p);
    $p = preg_replace('#/+#', '/', $p);
    $p = trim($p);
    $p = ltrim($p, '/');
    if ($p === '') return '';

    $parts = [];
    foreach (explode('/', $p) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') {
            if (count($parts) === 0) {
                throw new RuntimeException('Invalid path', 400);
            }
            array_pop($parts);
            continue;
        }
        $parts[] = $seg;
    }

    return implode('/', $parts);
}

function safe_join(string $root, string $rel): string {
    // root と相対パスを結合する。
    // - normalize_rel を通してディレクトリトラバーサルを防ぐ
    $rel = normalize_rel($rel);
    if ($rel === '') return $root;
    return $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
}

function safe_realpath_existing(string $root, string $rel): string {
    // 既存パスの realpath を取り、root 配下であることを保証する。
    // - 存在しなければ 404
    // - root の外へ出る場合は 400
    $abs = safe_join($root, $rel);
    $rp = realpath($abs);
    if ($rp === false) {
        throw new RuntimeException('Not found', 404);
    }
    $rootWithSep = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    if ($rp !== $root && strpos($rp, $rootWithSep) !== 0) {
        throw new RuntimeException('Path outside root', 400);
    }
    return $rp;
}

function stat_entry(string $root, string $abs): array {
    // `list` の1要素として返すエントリ形式に変換する。
    // `path` は root からの相対パス（/区切り）
    $name = basename($abs);
    $rel = str_replace(DIRECTORY_SEPARATOR, '/', ltrim(substr($abs, strlen(rtrim($root, DIRECTORY_SEPARATOR))), DIRECTORY_SEPARATOR));
    $isDir = is_dir($abs);
    $size = $isDir ? null : (is_file($abs) ? filesize($abs) : null);
    $mtime = @filemtime($abs);
    return [
        'name' => $name,
        'path' => $rel,
        'isDir' => $isDir,
        'size' => $size,
        'mtimeMs' => $mtime ? ($mtime * 1000) : null,
    ];
}

function mode_string(string $abs): ?string {
    // `ls -l` 風のパーミッション文字列を作る（例: drwxr-xr-x）。
    // Windows など取得できない環境では null。
    $perms = @fileperms($abs);
    if (!is_int($perms)) return null;

    $type = '-';
    if (is_dir($abs)) $type = 'd';
    elseif (is_link($abs)) $type = 'l';
    elseif (is_file($abs)) $type = '-';

    $out = $type;
    $map = [
        0o400 => 'r', 0o200 => 'w', 0o100 => 'x',
        0o040 => 'r', 0o020 => 'w', 0o010 => 'x',
        0o004 => 'r', 0o002 => 'w', 0o001 => 'x',
    ];
    foreach ($map as $bit => $ch) {
        $out .= (($perms & $bit) !== 0) ? $ch : '-';
    }
    return $out;
}

function owner_group(string $abs): array {
    // 所有者/グループを取得する。
    // - posix_* が使える場合は名前に変換
    // - 使えない場合は uid/gid（数値文字列）または空
    $uid = @fileowner($abs);
    $gid = @filegroup($abs);

    $owner = is_int($uid) ? (string)$uid : '';
    $group = is_int($gid) ? (string)$gid : '';

    if (is_int($uid) && function_exists('posix_getpwuid')) {
        $pw = @posix_getpwuid($uid);
        if (is_array($pw) && isset($pw['name']) && is_string($pw['name']) && $pw['name'] !== '') {
            $owner = $pw['name'];
        }
    }
    if (is_int($gid) && function_exists('posix_getgrgid')) {
        $gr = @posix_getgrgid($gid);
        if (is_array($gr) && isset($gr['name']) && is_string($gr['name']) && $gr['name'] !== '') {
            $group = $gr['name'];
        }
    }

    return ['owner' => $owner, 'group' => $group];
}

function rm_recursive(string $abs): void {
    // 再帰削除。
    // - シンボリックリンクは unlink（リンク先を辿らない）
    // - ディレクトリは中身を消してから rmdir
    if (is_link($abs) || is_file($abs)) {
        if (!@unlink($abs)) {
            throw new RuntimeException('Failed to delete');
        }
        return;
    }

    if (is_dir($abs)) {
        $items = scandir($abs);
        if ($items === false) throw new RuntimeException('Failed to read directory');
        foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            rm_recursive($abs . DIRECTORY_SEPARATOR . $it);
        }
        if (!@rmdir($abs)) {
            throw new RuntimeException('Failed to remove directory');
        }
        return;
    }

    throw new RuntimeException('Not found');
}

$action = isset($_GET['action']) ? (string)$_GET['action'] : '';
$rootKey = isset($_GET['root']) ? (string)$_GET['root'] : '';

try {
    $cfg = load_config();
    if ($action === 'config') {
        // フロントの初期化用設定。
        // - roots: ルート一覧
        // - defaultRoot: 初期選択
        // - content: 右ペイン有効/無効
        // - icons: 画像アイコン設定（任意）
        $rootsOut = [];
        foreach ($cfg['roots'] as $k => $v) {
            if (!is_array($v)) continue;
            $label = isset($v['label']) && is_string($v['label']) ? $v['label'] : (string)$k;
            $rootsOut[] = ['key' => (string)$k, 'label' => $label];
        }
        $contentEnabled = true;
        if (isset($cfg['content'])) {
            $contentEnabled = (bool)$cfg['content'];
        }
        $icons = null;
        if (isset($cfg['icons']) && is_array($cfg['icons'])) {
            $icons = $cfg['icons'];
        }
        json_response(200, [
            'defaultRoot' => (string)$cfg['defaultRoot'],
            'content' => $contentEnabled,
            'icons' => $icons,
            'roots' => $rootsOut,
        ]);
    }

    $ROOT = resolve_root($cfg, $rootKey);

    if ($action === 'list') {
        // ディレクトリ一覧。
        // - path を root 配下に閉じ込めてから scandir
        // - 返す path は normalize_rel したもの
        $rel = isset($_GET['path']) ? (string)$_GET['path'] : '';
        $abs = safe_join($ROOT, $rel);
        $rp = realpath($abs);
        if ($rp === false || !is_dir($rp)) {
            json_response(400, ['error' => 'Not a directory']);
        }
        $rootWithSep = rtrim($ROOT, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        if ($rp !== $ROOT && strpos($rp, $rootWithSep) !== 0) {
            json_response(400, ['error' => 'Path outside root']);
        }

        $names = scandir($rp);
        if ($names === false) json_response(500, ['error' => 'Failed to read directory']);

        $entries = [];
        foreach ($names as $n) {
            if ($n === '.' || $n === '..') continue;
            $entries[] = stat_entry($ROOT, $rp . DIRECTORY_SEPARATOR . $n);
        }

        usort($entries, function ($a, $b) {
            if ($a['isDir'] !== $b['isDir']) return $a['isDir'] ? -1 : 1;
            return strcmp($a['name'], $b['name']);
        });

        $currentRel = normalize_rel($rel);
        json_response(200, ['root' => $rootKey === '' ? (string)$cfg['defaultRoot'] : $rootKey, 'path' => $currentRel, 'entries' => $entries]);
    }

    if ($action === 'stat') {
        // プロパティ表示用。
        // - path の存在と root 配下を保証してから属性を返す
        $rel = isset($_GET['path']) ? (string)$_GET['path'] : '';
        $rel = normalize_rel($rel);
        $abs = safe_realpath_existing($ROOT, $rel);

        $isDir = is_dir($abs);
        $size = $isDir ? null : (is_file($abs) ? filesize($abs) : null);
        $mtime = @filemtime($abs);
        $mode = mode_string($abs);
        $og = owner_group($abs);

        json_response(200, [
            'path' => $rel,
            'name' => basename($abs),
            'isDir' => $isDir,
            'size' => $size,
            'mtimeMs' => $mtime ? ($mtime * 1000) : null,
            'mode' => $mode,
            'owner' => $og['owner'],
            'group' => $og['group'],
        ]);
    }

    if ($action === 'mkdir' || $action === 'touch' || $action === 'rename' || $action === 'delete' || $action === 'move' || $action === 'copy') {
        // 書き込み系操作。
        // - すべて CSRF 必須
        // - 入力は JSON ボディ（php://input）
        require_csrf();
        $raw = file_get_contents('php://input');
        $body = [];
        if (is_string($raw) && $raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) $body = $decoded;
        }

        if ($action === 'mkdir') {
            // フォルダ作成。
            // - name はパス区切り等を禁止
            // - 親ディレクトリが root 配下か確認
            $dir = isset($body['path']) ? (string)$body['path'] : '';
            $name = isset($body['name']) ? (string)$body['name'] : '';
            if ($name === '') json_response(400, ['error' => 'Missing name']);
            if (strpbrk($name, "\\/\0") !== false) json_response(400, ['error' => 'Invalid name']);

            $parent = safe_join($ROOT, $dir);
            $parentRp = realpath($parent);
            if ($parentRp === false || !is_dir($parentRp)) json_response(400, ['error' => 'Not a directory']);
            $rootWithSep = rtrim($ROOT, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            if ($parentRp !== $ROOT && strpos($parentRp, $rootWithSep) !== 0) json_response(400, ['error' => 'Path outside root']);

            $target = $parentRp . DIRECTORY_SEPARATOR . $name;
            if (file_exists($target)) json_response(409, ['error' => 'Already exists']);
            if (!@mkdir($target, 0775, false)) {
                $last = error_get_last();
                $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to create directory';
                json_response(500, ['error' => $msg . ' (' . $target . ')']);
            }
            json_response(200, ['ok' => true]);
        }

        if ($action === 'touch') {
            // 空ファイル作成。
            // - mkdir と同じく name を検証
            $dir = isset($body['path']) ? (string)$body['path'] : '';
            $name = isset($body['name']) ? (string)$body['name'] : '';
            if ($name === '') json_response(400, ['error' => 'Missing name']);
            if (strpbrk($name, "\\/\0") !== false) json_response(400, ['error' => 'Invalid name']);

            $parent = safe_join($ROOT, $dir);
            $parentRp = realpath($parent);
            if ($parentRp === false || !is_dir($parentRp)) json_response(400, ['error' => 'Not a directory']);
            $rootWithSep = rtrim($ROOT, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            if ($parentRp !== $ROOT && strpos($parentRp, $rootWithSep) !== 0) json_response(400, ['error' => 'Path outside root']);

            $target = $parentRp . DIRECTORY_SEPARATOR . $name;
            if (file_exists($target)) json_response(409, ['error' => 'Already exists']);
            $h = @fopen($target, 'x');
            if ($h === false) {
                $last = error_get_last();
                $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to create file';
                json_response(500, ['error' => $msg . ' (' . $target . ')']);
            }
            fclose($h);
            json_response(200, ['ok' => true]);
        }

        if ($action === 'rename') {
            // リネーム。
            // - 対象パスは root 配下に限定
            // - newName は区切り文字等を禁止
            // - rename 先が同じ親ディレクトリ内であることを検証
            $rel = isset($body['path']) ? (string)$body['path'] : '';
            $newName = isset($body['newName']) ? (string)$body['newName'] : '';
            if ($newName === '') json_response(400, ['error' => 'Missing newName']);
            if (strpbrk($newName, "\\/\0") !== false) json_response(400, ['error' => 'Invalid name']);

            $abs = safe_realpath_existing($ROOT, $rel);
            $parent = dirname($abs);
            $target = $parent . DIRECTORY_SEPARATOR . $newName;
            $targetRel = str_replace(DIRECTORY_SEPARATOR, '/', ltrim(substr($target, strlen(rtrim($ROOT, DIRECTORY_SEPARATOR))), DIRECTORY_SEPARATOR));
            $targetAbs = safe_join($ROOT, $targetRel);
            $targetParentRp = realpath(dirname($targetAbs));
            if ($targetParentRp === false || $targetParentRp !== $parent) json_response(400, ['error' => 'Invalid name']);

            if (!@rename($abs, $target)) json_response(500, ['error' => 'Failed to rename']);
            json_response(200, ['ok' => true]);
        }

        if ($action === 'delete') {
            // 削除（再帰）。
            // - root 自体の削除は拒否
            $rel = isset($body['path']) ? (string)$body['path'] : '';
            $rel = normalize_rel($rel);
            if ($rel === '') json_response(400, ['error' => 'Refuse to delete root']);
            $abs = safe_realpath_existing($ROOT, $rel);
            rm_recursive($abs);
            json_response(200, ['ok' => true]);
        }

        if ($action === 'move') {
            // 移動（複数）。
            // - destDir はディレクトリであること
            // - paths の各要素は root 配下・空（root）禁止
            // - 競合（同名存在）は 409
            $destDir = isset($body['destDir']) ? (string)$body['destDir'] : '';
            $destDir = normalize_rel($destDir);

            $paths = [];
            if (isset($body['paths']) && is_array($body['paths'])) {
                foreach ($body['paths'] as $p) {
                    if (!is_string($p)) continue;
                    $pp = normalize_rel($p);
                    if ($pp === '') json_response(400, ['error' => 'Refuse to move root']);
                    $paths[] = $pp;
                }
            }
            if (count($paths) === 0) json_response(400, ['error' => 'Missing paths']);

            $destAbs = safe_join($ROOT, $destDir);
            $destRp = realpath($destAbs);
            if ($destRp === false || !is_dir($destRp)) json_response(400, ['error' => 'Destination is not a directory']);
            $rootWithSep = rtrim($ROOT, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            if ($destRp !== $ROOT && strpos($destRp, $rootWithSep) !== 0) json_response(400, ['error' => 'Path outside root']);

            $moved = [];
            foreach ($paths as $rel) {
                $srcAbs = safe_realpath_existing($ROOT, $rel);
                $base = basename($srcAbs);
                if ($base === '' || $base === '.' || $base === '..') json_response(400, ['error' => 'Invalid name']);

                $target = $destRp . DIRECTORY_SEPARATOR . $base;
                if (file_exists($target)) json_response(409, ['error' => 'Already exists: ' . $base]);

                if (!@rename($srcAbs, $target)) {
                    $last = error_get_last();
                    $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to move';
                    json_response(500, ['error' => $msg . ' (' . $rel . ' -> ' . $destDir . '/' . $base . ')']);
                }
                $moved[] = ['from' => $rel, 'to' => ($destDir === '' ? $base : ($destDir . '/' . $base))];
            }

            json_response(200, ['ok' => true, 'moved' => $moved]);
        }

        if ($action === 'copy') {
            // コピー（複数）。
            // - move と同じ検証に加え、ディレクトリは再帰コピー
            // - シンボリックリンクはコピー禁止
            $destDir = isset($body['destDir']) ? (string)$body['destDir'] : '';
            $destDir = normalize_rel($destDir);

            $paths = [];
            if (isset($body['paths']) && is_array($body['paths'])) {
                foreach ($body['paths'] as $p) {
                    if (!is_string($p)) continue;
                    $pp = normalize_rel($p);
                    if ($pp === '') json_response(400, ['error' => 'Refuse to copy root']);
                    $paths[] = $pp;
                }
            }
            if (count($paths) === 0) json_response(400, ['error' => 'Missing paths']);

            $destAbs = safe_join($ROOT, $destDir);
            $destRp = realpath($destAbs);
            if ($destRp === false || !is_dir($destRp)) json_response(400, ['error' => 'Destination is not a directory']);
            $rootWithSep = rtrim($ROOT, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            if ($destRp !== $ROOT && strpos($destRp, $rootWithSep) !== 0) json_response(400, ['error' => 'Path outside root']);

            $copied = [];
            foreach ($paths as $rel) {
                $srcAbs = safe_realpath_existing($ROOT, $rel);
                $base = basename($srcAbs);
                if ($base === '' || $base === '.' || $base === '..') json_response(400, ['error' => 'Invalid name']);

                $target = $destRp . DIRECTORY_SEPARATOR . $base;
                if (file_exists($target)) json_response(409, ['error' => 'Already exists: ' . $base]);

                try {
                    copy_recursive($srcAbs, $target);
                } catch (RuntimeException $e) {
                    $code = (int)$e->getCode();
                    if ($code >= 400 && $code < 600) {
                        throw $e;
                    }
                    throw new RuntimeException($e->getMessage(), 500);
                }
                $copied[] = ['from' => $rel, 'to' => ($destDir === '' ? $base : ($destDir . '/' . $base))];
            }

            json_response(200, ['ok' => true, 'copied' => $copied]);
        }
    }

    if ($action === 'upload') {
        // アップロード。
        // - CSRF 必須
        // - multipart/form-data の `file` を受け取る
        // - 保存先は `path`（GETパラメータ）で指定
        require_csrf();
        $dir = isset($_GET['path']) ? (string)$_GET['path'] : '';
        $dirAbs = safe_join($ROOT, $dir);
        $dirRp = realpath($dirAbs);
        if ($dirRp === false || !is_dir($dirRp)) json_response(400, ['error' => 'Not a directory']);
        $rootWithSep = rtrim($ROOT, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        if ($dirRp !== $ROOT && strpos($dirRp, $rootWithSep) !== 0) json_response(400, ['error' => 'Path outside root']);

        if (!isset($_FILES['file']) || !is_array($_FILES['file'])) json_response(400, ['error' => 'Missing file']);
        $f = $_FILES['file'];

        $err = isset($f['error']) ? (int)$f['error'] : 0;
        if ($err !== UPLOAD_ERR_OK) {
            $map = [
                UPLOAD_ERR_INI_SIZE => 'File exceeds upload_max_filesize',
                UPLOAD_ERR_FORM_SIZE => 'File exceeds MAX_FILE_SIZE',
                UPLOAD_ERR_PARTIAL => 'File was only partially uploaded',
                UPLOAD_ERR_NO_FILE => 'No file was uploaded',
                UPLOAD_ERR_NO_TMP_DIR => 'Missing a temporary folder',
                UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk',
                UPLOAD_ERR_EXTENSION => 'A PHP extension stopped the file upload',
            ];
            $msg = isset($map[$err]) ? $map[$err] : ('Upload failed (code ' . (string)$err . ')');
            json_response(400, ['error' => $msg]);
        }

        if (!isset($f['tmp_name'], $f['name']) || !is_string($f['tmp_name']) || !is_string($f['name'])) {
            json_response(400, ['error' => 'Invalid upload']);
        }
        if ($f['tmp_name'] === '' || !is_uploaded_file($f['tmp_name'])) {
            json_response(400, ['error' => 'Invalid tmp file']);
        }
        $name = basename($f['name']);
        if ($name === '' || strpbrk($name, "\\/\0") !== false) json_response(400, ['error' => 'Invalid filename']);

        $target = $dirRp . DIRECTORY_SEPARATOR . $name;
        if (!@move_uploaded_file($f['tmp_name'], $target)) {
            $last = error_get_last();
            $msg = is_array($last) && isset($last['message']) ? (string)$last['message'] : 'Failed to save file';
            json_response(500, ['error' => $msg . ' (' . $target . ')']);
        }
        json_response(200, ['ok' => true]);
    }

    if ($action === 'download') {
        // ダウンロード。
        // - JSON ではなくバイナリを返すため json_response は使わない
        $rel = isset($_GET['path']) ? (string)$_GET['path'] : '';
        $abs = safe_realpath_existing($ROOT, $rel);
        if (!is_file($abs)) {
            http_response_code(400);
            header('Content-Type: text/plain; charset=utf-8');
            echo "Not a file";
            exit;
        }

        $name = basename($abs);
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . (string)filesize($abs));
        header('Content-Disposition: attachment; filename="' . rawurlencode($name) . '"');
        readfile($abs);
        exit;
    }

    json_response(404, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    // 例外は API エラーとして JSON で返す。
    // - RuntimeException の code が 4xx/5xx の場合はそのまま採用
    // - それ以外は 500
    $code = (int)$e->getCode();
    if ($code >= 400 && $code < 600) {
        json_response($code, ['error' => $e->getMessage()]);
    }
    json_response(500, ['error' => $e->getMessage()]);
}
