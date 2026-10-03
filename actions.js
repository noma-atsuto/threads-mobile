// iPhoneでの操作（承認・取り消し・却下など）を、投稿一覧に当てはめる共通の部品。
// iPhoneの画面・GitHubの投稿係・PCのダッシュボードの3か所で同じものを使い、同じ結果になるようにする。
// ダッシュボードの server.js の各操作と同じ決まりで動かす（決まりを変えるときは両方を直す）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThreadsActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TEXT_LIMIT = 500;
  const LINK_LIMIT = 5;

  // Threadsの数え方: 500文字まで。ただし絵文字はUTF-8のバイト数で数える（lib/threads.js と同じ）
  function countText(text) {
    let n = 0;
    for (const ch of text || '') {
      n += /\p{Extended_Pictographic}|[‍️\u{1f3fb}-\u{1f3ff}]/u.test(ch) ? new TextEncoder().encode(ch).length : 1;
    }
    return n;
  }
  function checkText(text) {
    if (!text || !text.trim()) return '本文が空です。';
    const n = countText(text);
    if (n > TEXT_LIMIT) return `本文が長すぎます（${n}/${TEXT_LIMIT}。絵文字は1つで数文字分に数えられます）。`;
    if (((text || '').match(/https?:\/\/\S+/g) || []).length > LINK_LIMIT) return `リンクは${LINK_LIMIT}個までです。`;
    return null;
  }

  const keyOf = (p) => `${p.id}@${p.scheduled_at}`;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // 操作を順に当てはめる。当てはめられない操作（すでに投稿済みなど）は飛ばす。
  // 戻り値: items（当てはめ後の投稿一覧）、feedback（記録するダメ出し）、generate（投稿案づくりを頼まれたか）、skipped（飛ばした操作）
  function applyActions(items, actions) {
    const out = clone(items || []);
    const feedback = [];
    const skipped = [];
    let generate = false;
    const sorted = [...(actions || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const a of sorted) {
      if (a.type === 'generate') { generate = true; continue; }
      const p = out.find((x) => x.id === a.post_id);
      const skip = (why) => skipped.push({ id: a.id, why });
      if (!p) { skip('投稿が見つかりません'); continue; }
      switch (a.type) {
        case 'edit': {
          if (['posting', 'posted'].includes(p.status)) { skip('投稿済みの内容は変更できません'); break; }
          const text = String(a.text || '').trim();
          if (!text) { skip('本文が空です'); break; }
          if (text !== p.text) {
            p.original_text = p.original_text || p.text;
            p.text = text;
            p.edited = true;
          }
          break;
        }
        case 'approve':
        case 'post_now': {
          const when = a.type === 'post_now' ? new Date(a.at) : new Date(a.scheduled_at);
          if (isNaN(when)) { skip('日時が読めません'); break; }
          if (when.getTime() < new Date(a.at).getTime() - 60000) { skip('過去の日時は選べません'); break; }
          if (!['draft', 'approved', 'failed', 'needs_check'].includes(p.status)) { skip('この投稿は予約できません'); break; }
          const problem = checkText(p.text);
          if (problem) { skip(problem); break; }
          Object.assign(p, { status: 'approved', scheduled_at: when.toISOString(), approved_at: a.at, error: null });
          // 本人が手直ししてから承認した投稿は、直し方そのものがフィードバックになる
          if (p.edited && p.original_text && !p.edit_recorded && p.original_text !== p.text) {
            feedback.push({ action_id: a.id, kind: '手直し', post_id: p.id, text: p.text, before: p.original_text, after: p.text, reason: '本人が本文を手直ししてから承認した（元の文と直した後の違いから、直し方のクセを読み取る）' });
            p.edit_recorded = true;
          }
          break;
        }
        case 'unschedule':
          if (!['approved', 'failed', 'needs_check'].includes(p.status)) { skip('予約中の投稿ではありません'); break; }
          Object.assign(p, { status: 'draft', scheduled_at: null, error: null });
          break;
        case 'reject': {
          if (['posting', 'posted'].includes(p.status)) { skip('投稿済みのものは却下できません'); break; }
          const reason = String(a.reason || '').trim();
          if (!reason) { skip('却下の理由がありません'); break; }
          feedback.push({ action_id: a.id, kind: '却下', post_id: p.id, text: p.text, reason });
          Object.assign(p, { status: 'rejected', reject_reason: reason, rejected_at: a.at, scheduled_at: null, regen: a.regen ? 'waiting' : null });
          break;
        }
        case 'restore':
          if (p.status !== 'rejected') { skip('却下した投稿ではありません'); break; }
          p.status = 'draft';
          p.regen = null;
          break;
        case 'confirm_posted':
          if (p.status !== 'needs_check') { skip('確認待ちの投稿ではありません'); break; }
          Object.assign(p, { status: 'posted', posted_at: p.posted_at || a.at, error: null, note: '手動で投稿済みと確認' });
          break;
        case 'feedback': {
          const reason = String(a.reason || '').trim();
          if (reason) feedback.push({ action_id: a.id, kind: 'ダメ出しメモ', post_id: p.id, text: p.text, reason });
          break;
        }
        default:
          skip('知らない操作です');
      }
    }
    return { items: out, feedback, generate, skipped };
  }

  // クラウドの投稿結果を、表示用に投稿一覧へ重ねる（PCの lib/cloud.js の applyResults と同じ決まり）
  function overlayResults(items, results, now = Date.now()) {
    const out = clone(items || []);
    for (const [key, r] of Object.entries(results || {})) {
      const at = key.lastIndexOf('@');
      const p = out.find((x) => x.id === key.slice(0, at));
      if (!p) continue;
      if (r.status === 'posted') {
        if (p.status !== 'posted' && p.status !== 'archived') Object.assign(p, { status: 'posted', posted_at: r.at, permalink: r.permalink || null, error: null });
        continue;
      }
      if (p.status !== 'approved' || p.scheduled_at !== key.slice(at + 1)) continue;
      if (r.status === 'late') Object.assign(p, { status: 'needs_check', error: '予約時刻から6時間以上たっていたため、投稿を止めました。' });
      else if (r.status === 'failed' || r.status === 'needs_check') Object.assign(p, { status: r.status, error: r.error || '投稿に失敗しました' });
      else if (r.status === 'posting') {
        if (now - new Date(r.at).getTime() > 20 * 60 * 1000) Object.assign(p, { status: 'needs_check', error: '投稿の途中で止まりました。Threadsアプリで投稿されていないか確認してください。' });
        else p.status = 'posting';
      }
    }
    return out;
  }

  // PCが送った一覧（state）に、まだPCが取り込んでいないiPhoneの操作を当てはめる
  function pendingActions(state, actions) {
    const applied = new Set((state && state.applied) || []);
    return ((actions && actions.items) || []).filter((a) => !applied.has(a.id));
  }
  function effectiveItems(state, actions) {
    return applyActions((state && state.items) || [], pendingActions(state, actions)).items;
  }

  // 投稿係が出すべき予約（承認済み・時刻あり・まだ結果が出ていないもの）
  function dueQueue(state, actions, results) {
    if (!state || !state.enabled) return [];
    return effectiveItems(state, actions)
      .filter((p) => p.status === 'approved' && p.scheduled_at && !(results && results[keyOf(p)]))
      .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  }

  return { TEXT_LIMIT, countText, checkText, keyOf, applyActions, overlayResults, pendingActions, effectiveItems, dueQueue };
});
