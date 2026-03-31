import { createApi } from './core/api.js';
import { createStore } from './core/store.js';
import { createCommands } from './core/commands.js';
import { createVsCodeExplorerView } from './views/vscodeExplorerView.js';

// `public/` 配下で開いた場合と、プロジェクト直下で開いた場合で
// API の相対パスが変わるため、現在の URL から baseUrl を決める。
const isUnderPublic = window.location.pathname.includes('/public/');
const apiBaseUrl = isUnderPublic ? './api.php' : './public/api.php';
const api = createApi({ baseUrl: apiBaseUrl });

// ディレクトリごとの表示モード（list/icons）を永続化する Cookie 名
const VIEWMODE_COOKIE = 'sweFilemanager.viewModeByDir';

function cookiePath() {
	// Cookie の Path を filemanager の配下に固定する。
	// 例: /xxx/filemanager/ 以下のどこから開いても同じ Cookie を参照できる。
	const p = window.location.pathname;
	const idx = p.indexOf('/filemanager/');
	if (idx >= 0) return p.slice(0, idx + '/filemanager/'.length);
	return '/';
}

function readCookie(name) {
	// document.cookie から単純にキー一致で値を取り出す
	const parts = (document.cookie ?? '').split(';');
	for (const part of parts) {
		const s = part.trim();
		if (!s) continue;
		const eq = s.indexOf('=');
		if (eq < 0) continue;
		const k = s.slice(0, eq).trim();
		if (k !== name) continue;
		return s.slice(eq + 1);
	}
	return '';
}

function writeCookie(name, value) {
	// Cookie に JSON 文字列を保存するためエンコードする
	const v = encodeURIComponent(value);
	document.cookie = `${name}=${v}; Path=${cookiePath()}; Max-Age=31536000; SameSite=Lax`;
}

function loadViewModePrefs() {
	// Cookie に保存された「root + dirPath -> viewMode」の辞書を読む
	const raw = readCookie(VIEWMODE_COOKIE);
	if (!raw) return {};
	try {
		const decoded = decodeURIComponent(raw);
		const data = JSON.parse(decoded);
		return data && typeof data === 'object' ? data : {};
	} catch {
		return {};
	}
}

function saveViewModePrefs(prefs) {
	// Cookie に辞書を書き戻す
	try {
		writeCookie(VIEWMODE_COOKIE, JSON.stringify(prefs ?? {}));
	} catch {
		writeCookie(VIEWMODE_COOKIE, '{}');
	}
}

function normalizeDirPath(p) {
	// `a/b/` や `/a/b` のような表記揺れを正規化（先頭/末尾の / を除去）
	return (p ?? '').toString().replace(/^\/+/, '').replace(/\/+$/, '');
}

function parentDir(p) {
	// `a/b/c` -> `a/b`
	const parts = normalizeDirPath(p).split('/').filter(Boolean);
	parts.pop();
	return parts.join('/');
}

function prefKey(root, dirPath) {
	// 「root + ディレクトリパス」単位で viewMode を保存するキー
	return `${root ?? ''}|${normalizeDirPath(dirPath)}`;
}

function setPref(prefs, root, dirPath, mode) {
	// mode を保存用に短い文字（i/l）で持つ
	const k = prefKey(root, dirPath);
	const v = mode === 'icons' ? 'i' : 'l';
	if (v === 'l') {
		delete prefs[k];
		return;
	}
	prefs[k] = v;
}

function getInheritedPref(prefs, root, dirPath) {
	// 指定ディレクトリに明示設定がない場合は親へ遡って継承する。
	// 例: a/b/c が未設定なら a/b -> a -> '' の順で探す。
	let p = normalizeDirPath(dirPath);
	while (true) {
		const k = prefKey(root, p);
		const v = prefs[k];
		if (v === 'i') return 'icons';
		if (v === 'l') return 'list';
		if (!p) break;
		p = parentDir(p);
	}
	return 'list';
}

const store = createStore({
	// UI 全体の状態
	currentRoot: '',
	// 現在開いているディレクトリ（root からの相対パス）
	cwd: '',
	// 右ペイン一覧（list action の結果）
	listing: [],
	// パンくず表示用パス（サーバ側で正規化された値）
	breadcrumb: '',
	// 右ペインの表示モード（list/icons）
	viewMode: 'list',
	// config.json の content フラグ（false の場合 UI を簡易化）
	contentEnabled: true,
	// config.json の icons 設定（画像アイコン用）
	iconsConfig: null,
});

const commands = createCommands({ api, store });

const viewModePrefs = loadViewModePrefs();
let lastKey = '';
let lastMode = '';
let applying = false;

store.subscribe((state) => {
	// cwd/root が変わったら、そのディレクトリに対する保存済み viewMode を反映する
	const key = `${state.currentRoot}|${state.cwd}`;
	if (key !== lastKey) {
		lastKey = key;
		const desired = getInheritedPref(viewModePrefs, state.currentRoot, state.cwd);
		if (state.viewMode !== desired) {
			applying = true;
			store.setState({ viewMode: desired });
			applying = false;
		}
	}

	// ユーザ操作で viewMode が変わったら Cookie に保存する
	if (!applying && state.viewMode !== lastMode) {
		lastMode = state.viewMode;
		setPref(viewModePrefs, state.currentRoot, state.cwd, state.viewMode);
		saveViewModePrefs(viewModePrefs);
	}
});

async function init() {
	// 起動処理
	// 1) config 取得
	// 2) ルート一覧を root-select に反映
	// 3) store へ content/icons を保存
	// 4) View を生成
	// 5) 初期ディレクトリへ navigate
	const rootSelect = document.getElementById('root-select');
	const cfg = await api.getConfig();

	const roots = Array.isArray(cfg.roots) ? cfg.roots : [];
	rootSelect.innerHTML = '';
	for (const r of roots) {
		if (!r || typeof r.key !== 'string') continue;
		const opt = document.createElement('option');
		opt.value = r.key;
		opt.textContent = typeof r.label === 'string' ? r.label : r.key;
		rootSelect.appendChild(opt);
	}

	const defaultRoot = typeof cfg.defaultRoot === 'string' ? cfg.defaultRoot : roots[0]?.key;
	store.setState({
		currentRoot: defaultRoot ?? '',
		contentEnabled: cfg?.content !== false,
		iconsConfig: cfg?.icons && typeof cfg.icons === 'object' ? cfg.icons : null,
	});
	rootSelect.value = defaultRoot ?? '';

	createVsCodeExplorerView({ store, commands });
	await commands.navigate('');
}

init().catch((e) => {
	alert(e?.message ?? String(e));
});
