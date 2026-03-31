export function createStore(initialState) {
  // シンプルな状態管理（Pub/Sub）
  // - `state` は常に「最新の状態オブジェクト」を指す
  // - `setState` で状態を更新し、購読者（listeners）へ通知する
  // - Redux のような制約はなく、UI 側が必要十分な粒度で使う想定
  let state = { ...initialState };
  const listeners = new Set();

  function getState() {
    // 現在の状態を返す（参照）
    return state;
  }

  function setState(patch) {
    // 状態を更新して購読者に通知する。
    // - `patch` が関数の場合: `patch(state)` の戻り値を次の state として採用
    // - `patch` がオブジェクトの場合: `{...state, ...patch}` の浅いマージ
    // 
    // NOTE:
    // - 深いマージはしない（必要なら呼び出し側で作る）
    // - 参照が変わるので、購読側は差分検出しやすい
    const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
    state = next;
    for (const fn of listeners) fn(state);
  }

  function subscribe(fn) {
    // 変更通知を購読する。戻り値は購読解除関数。
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { getState, setState, subscribe };
}
