<?php

declare(strict_types=1);

header('X-Content-Type-Options: nosniff');

function load_config(string $projectRoot): array {
    $cfgPath = realpath($projectRoot . '/config.json');
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
    if (!is_array($decoded) || !isset($decoded['roots']) || !is_array($decoded['roots'])) {
        throw new RuntimeException('Invalid config.json', 500);
    }
    if (!isset($decoded['defaultRoot']) || !is_string($decoded['defaultRoot'])) {
        $decoded['defaultRoot'] = array_key_first($decoded['roots']);
    }
    return $decoded;
}

function normalize_rel(string $p): string {
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

function resolve_root(array $cfg, string $rootKey, string $projectRoot): string {
    if ($rootKey === '') {
        $rootKey = (string)$cfg['defaultRoot'];
    }
    if (!isset($cfg['roots'][$rootKey]) || !is_array($cfg['roots'][$rootKey])) {
        // rootKey が key ではなく label（表示名）として渡ってくるケースに対応
        // 例: config.json の roots が {"demo": {"label": "data"}} の時、URL は /thumb/data/... になりがち
        $found = '';
        foreach (($cfg['roots'] ?? []) as $k => $def) {
            if (!is_array($def)) continue;
            $label = isset($def['label']) && is_string($def['label']) ? $def['label'] : '';
            if ($label !== '' && $label === $rootKey) {
                $found = (string)$k;
                break;
            }
        }
        if ($found === '') {
            throw new RuntimeException('Unknown root', 400);
        }
        $rootKey = $found;
    }
    $rootDef = $cfg['roots'][$rootKey];
    $relPath = isset($rootDef['path']) && is_string($rootDef['path']) ? $rootDef['path'] : '';
    if ($relPath === '') {
        throw new RuntimeException('Invalid root path', 500);
    }

    $abs = $relPath;
    if (!preg_match('#^/|^[A-Za-z]:\\\\#', $relPath)) {
        $abs = $projectRoot . '/' . $relPath;
    }

    $rp = realpath($abs);
    if ($rp === false) {
        throw new RuntimeException('Root not found', 500);
    }
    return $rp;
}

function safe_realpath_existing(string $root, string $rel): string {
    $rel = normalize_rel($rel);
    $abs = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
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

function read_int(string $k, int $def, int $min, int $max): int {
    $v = isset($_GET[$k]) ? (string)$_GET[$k] : '';
    if ($v === '') return $def;
    if (!preg_match('/^\d+$/', $v)) return $def;
    $n = (int)$v;
    if ($n < $min) return $min;
    if ($n > $max) return $max;
    return $n;
}

function output_image($img, string $fmt, int $q): void {
    if ($fmt === 'png') {
        header('Content-Type: image/png');
        imagepng($img);
        return;
    }
    if ($fmt === 'jpeg') {
        header('Content-Type: image/jpeg');
        imagejpeg($img, null, $q);
        return;
    }
    header('Content-Type: image/webp');
    imagewebp($img, null, $q);
}

function send_error(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $msg;
    exit;
}

function extract_src_from_request_uri(): string {
    // rewrite の仕方によって PATH_INFO が渡らない場合があるため、
    // REQUEST_URI から /thumb/ 以降のパスを復元するフォールバック。
    $uri = isset($_SERVER['REQUEST_URI']) && is_string($_SERVER['REQUEST_URI']) ? (string)$_SERVER['REQUEST_URI'] : '';
    if ($uri === '') return '';
    $path = parse_url($uri, PHP_URL_PATH);
    if (!is_string($path) || $path === '') return '';
    $pos = strpos($path, '/thumb/');
    if ($pos === false) return '';
    $tail = substr($path, $pos + strlen('/thumb/'));
    if (!is_string($tail)) return '';
    $tail = ltrim($tail, '/');
    // URL エンコードされた日本語パス等を復元
    return rawurldecode($tail);
}

try {
    $projectRoot = realpath(__DIR__);
    if ($projectRoot === false) {
        send_error(500, 'Project root not found');
    }

    $cfg = load_config($projectRoot);

    $pathInfo = isset($_SERVER['PATH_INFO']) && is_string($_SERVER['PATH_INFO']) ? (string)$_SERVER['PATH_INFO'] : '';
    $srcFromPath = $pathInfo !== '' ? ltrim($pathInfo, '/') : '';
    if ($srcFromPath !== '') {
        // PATH_INFO に %XX が残る環境向け
        $srcFromPath = rawurldecode($srcFromPath);
    }

    $rootKey = isset($_GET['root']) && is_string($_GET['root']) ? (string)$_GET['root'] : '';
    $rel = isset($_GET['path']) && is_string($_GET['path']) ? (string)$_GET['path'] : '';
    $src = isset($_GET['src']) && is_string($_GET['src']) ? (string)$_GET['src'] : '';

    if ($srcFromPath !== '') {
        $src = $srcFromPath;
    }

    if ($src === '' && $rel === '') {
        $src = extract_src_from_request_uri();
    }

    if ($src !== '') {
        $src = normalize_rel($src);
        $parts = $src === '' ? [] : explode('/', $src);
        if ($rel === '' && count($parts) >= 2) {
            $rootKey = $rootKey !== '' ? $rootKey : (string)array_shift($parts);
            $rel = implode('/', $parts);
        } elseif ($rel === '') {
            $rel = $src;
        }
    }

    if ($rel === '') {
        send_error(400, 'Missing path');
    }

    $ROOT = resolve_root($cfg, $rootKey, $projectRoot);
    $abs = safe_realpath_existing($ROOT, $rel);
    if (!is_file($abs)) {
        send_error(400, 'Not a file');
    }

    $w = read_int('w', 256, 16, 2048);
    $h = read_int('h', 256, 16, 2048);
    $fit = isset($_GET['fit']) && is_string($_GET['fit']) ? (string)$_GET['fit'] : 'contain';
    if ($fit !== 'contain' && $fit !== 'cover') $fit = 'contain';

    $fmt = isset($_GET['fmt']) && is_string($_GET['fmt']) ? strtolower((string)$_GET['fmt']) : 'webp';
    if ($fmt !== 'webp' && $fmt !== 'jpeg' && $fmt !== 'jpg' && $fmt !== 'png') $fmt = 'webp';
    if ($fmt === 'jpg') $fmt = 'jpeg';

    $q = read_int('q', 80, 10, 95);

    $mtime = @filemtime($abs);
    $size = @filesize($abs);
    $etag = '"' . sha1($abs . '|' . (string)$mtime . '|' . (string)$size . '|' . (string)$w . 'x' . (string)$h . '|' . $fit . '|' . $fmt . '|' . (string)$q) . '"';
    header('ETag: ' . $etag);
    if (isset($_SERVER['HTTP_IF_NONE_MATCH']) && is_string($_SERVER['HTTP_IF_NONE_MATCH']) && trim((string)$_SERVER['HTTP_IF_NONE_MATCH']) === $etag) {
        http_response_code(304);
        exit;
    }

    $cacheDir = $projectRoot . '/.thumb-cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0775, true);
    }

    $cacheWritable = is_dir($cacheDir) && is_writable($cacheDir);
    if ($cacheWritable) {
        $cacheFile = $cacheDir . '/' . trim($etag, '"') . '.' . $fmt;
        if (is_file($cacheFile)) {
            header('Cache-Control: public, max-age=31536000, immutable');
            if ($fmt === 'png') header('Content-Type: image/png');
            elseif ($fmt === 'jpeg') header('Content-Type: image/jpeg');
            else header('Content-Type: image/webp');
            readfile($cacheFile);
            exit;
        }
    }

    if (!function_exists('imagecreatefromstring')) {
        send_error(500, 'GD not available');
    }

    $raw = file_get_contents($abs);
    if (!is_string($raw) || $raw === '') {
        send_error(500, 'Failed to read file');
    }
    $srcImg = @imagecreatefromstring($raw);
    if ($srcImg === false) {
        send_error(400, 'Unsupported image');
    }

    $srcW = imagesx($srcImg);
    $srcH = imagesy($srcImg);
    if ($srcW <= 0 || $srcH <= 0) {
        imagedestroy($srcImg);
        send_error(400, 'Invalid image');
    }

    $dst = imagecreatetruecolor($w, $h);
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    $transparent = imagecolorallocatealpha($dst, 0, 0, 0, 127);
    imagefilledrectangle($dst, 0, 0, $w, $h, $transparent);

    $scale = $fit === 'cover' ? max($w / $srcW, $h / $srcH) : min($w / $srcW, $h / $srcH);
    $newW = (int)max(1, round($srcW * $scale));
    $newH = (int)max(1, round($srcH * $scale));
    $dstX = (int)floor(($w - $newW) / 2);
    $dstY = (int)floor(($h - $newH) / 2);

    imagecopyresampled($dst, $srcImg, $dstX, $dstY, 0, 0, $newW, $newH, $srcW, $srcH);
    imagedestroy($srcImg);

    $ok = false;
    if ($fmt === 'png') {
        $ok = $cacheWritable ? @imagepng($dst, $cacheFile) : false;
        header('Content-Type: image/png');
    } elseif ($fmt === 'jpeg') {
        $ok = $cacheWritable ? @imagejpeg($dst, $cacheFile, $q) : false;
        header('Content-Type: image/jpeg');
    } else {
        if (!function_exists('imagewebp')) {
            $fmt = 'jpeg';
            if ($cacheWritable) {
                $cacheFile = $cacheDir . '/' . trim($etag, '"') . '.jpeg';
                $ok = @imagejpeg($dst, $cacheFile, $q);
            }
            header('Content-Type: image/jpeg');
        } else {
            $ok = $cacheWritable ? @imagewebp($dst, $cacheFile, $q) : false;
            header('Content-Type: image/webp');
        }
    }

    if (!$ok || !$cacheWritable || !isset($cacheFile) || !is_file($cacheFile)) {
        header('Cache-Control: no-store');
        if ($fmt === 'webp' && !function_exists('imagewebp')) {
            $fmt = 'jpeg';
        }
        if ($fmt === 'webp') {
            output_image($dst, 'webp', $q);
        } else {
            output_image($dst, $fmt, $q);
        }
        imagedestroy($dst);
        exit;
    }

    imagedestroy($dst);

    header('Cache-Control: public, max-age=31536000, immutable');
    readfile($cacheFile);
    exit;
} catch (Throwable $e) {
    $code = (int)$e->getCode();
    if ($code < 400 || $code >= 600) $code = 500;
    send_error($code, $e->getMessage());
}