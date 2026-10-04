// Threads予約（iPhone用）。PCが閉じていても、GitHubの非公開リポジトリを通して予約を操作する。
// 読むもの: data/state.json（PCが送った投稿一覧）・data/actions.json（この画面での操作）・data/results.json（投稿係の結果）
// 書くもの: data/actions.json だけ（操作を1件ずつ足す）。投稿一覧そのものは書き換えない。
// 合鍵（GitHubのアクセストークン）はこのiPhoneの中にだけ保存する。
(() => {
  'use strict';
  const A = window.ThreadsActions;
  const STORE_KEY = 'threads-mobile';

  /* ---------- 保存（このiPhoneの中だけ） ---------- */
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; }
  }
  function saveCfg(c) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(c)); return true; } catch (_) { return false; }
  }
  let cfg = loadCfg();

  // Macのダッシュボードに出るQRコード（…#c=つなぐための文字）から開いたら、そのまま覚える
  const STANDALONE = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  function readConnectCode(text) {
    const m = String(text || '').match(/[#&]c=([A-Za-z0-9_-]+)/) || String(text || '').match(/^\s*([A-Za-z0-9_-]{40,})\s*$/);
    if (!m) return null;
    try {
      const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
      return j.r && j.t ? { repo: j.r, token: j.t, code: m[1] } : null;
    } catch (_) {
      return null;
    }
  }
  let justConnected = false;
  const fromLink = readConnectCode(location.hash);
  if (fromLink) {
    cfg = { repo: fromLink.repo, token: fromLink.token };
    saveCfg(cfg);
    justConnected = true;
    // ホーム画面に追加したアプリは、Safariと保存場所が別になる。追加するときに住所ごと引き継げるよう、
    // Safariで開いている間は住所を残し、ホーム画面のアプリで開いたときに消す
    if (STANDALONE) history.replaceState(null, '', location.pathname);
  }
  // 動作確認用: 手元のテスト用サーバー（localhost）にだけ差し替えられる。合鍵がほかの場所に送られないようにするため
  const hashApi = new URLSearchParams(location.hash.slice(1)).get('api');
  const API = hashApi && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(hashApi) ? hashApi : 'https://api.github.com';

  /* ---------- GitHubとのやり取り ---------- */
  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(`${API}/${path}`, {
        ...opts,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }
      });
    } catch (_) {
      throw new Error('インターネットにつながっていません');
    }
    if (res.status === 401) throw Object.assign(new Error('合鍵が使えません（期限切れか、まちがっている可能性があります）。設定から登録し直してください'), { status: 401 });
    if (res.status === 403) throw Object.assign(new Error('合鍵に必要な許可がありません（Contents と Actions の「Read and write」が必要です）'), { status: 403 });
    return res;
  }
  const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const b64encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function getFile(path) {
    const res = await api(`repos/${cfg.repo}/contents/${path}?t=${Date.now()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHubから読めませんでした（${res.status}）`);
    const j = await res.json();
    return { sha: j.sha, data: JSON.parse(b64decode(j.content)) };
  }

  // 操作を1件足す。読んだ版（sha）を指定して書くので、PCやほかの操作と重なったら読み直してやり直す
  async function addAction(action) {
    const a = { id: `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...action };
    for (let i = 0; i < 4; i++) {
      const f = await getFile('data/actions.json');
      const items = f ? (f.data.items || []) : [];
      items.push(a);
      const body = { message: `iPhoneで操作: ${a.type}`, content: b64encode(JSON.stringify({ items }, null, 2) + '\n'), ...(f ? { sha: f.sha } : {}) };
      const res = await api(`repos/${cfg.repo}/contents/data/actions.json`, { method: 'PUT', body: JSON.stringify(body) });
      if (res.ok) {
        D.actions = { items };
        return a;
      }
      if (![409, 422].includes(res.status)) throw new Error(`GitHubに保存できませんでした（${res.status}）`);
    }
    throw new Error('混み合っていて保存できませんでした。少し待ってからもう一度お試しください');
  }

  // 「今すぐ投稿」は投稿係をすぐに動かす
  async function runPoster() {
    const res = await api(`repos/${cfg.repo}/actions/workflows/post.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
    if (!res.ok) throw new Error(`投稿係を動かせませんでした（${res.status}）。次の決まった時刻に投稿されます`);
  }

  /* ---------- データ ---------- */
  const D = { state: null, actions: { items: [] }, results: {}, loadedAt: null };
  let posts = [];

  function compute() {
    if (!D.state) { posts = []; return; }
    posts = A.overlayResults(A.effectiveItems(D.state, D.actions), D.results);
  }

  async function load({ quiet = false } = {}) {
    if (!cfg.token) return;
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    try {
      const [s, a, r] = await Promise.all([getFile('data/state.json'), getFile('data/actions.json'), getFile('data/results.json')]);
      if (!s) throw new Error('まだPCから投稿一覧が届いていません。PCのダッシュボードを一度開いてください');
      D.state = s.data;
      D.actions = a ? a.data : { items: [] };
      D.results = r ? (r.data.items || {}) : {};
      D.loadedAt = new Date();
      D.error = null;
      compute();
    } catch (e) {
      D.error = e.message;
      if (!quiet) toast(e.message, true);
      if (e.status === 401) { cfg = {}; saveCfg(cfg); }
    } finally {
      btn.classList.remove('spinning');
      render();
    }
  }

  /* ---------- 表示の部品 ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
  const fmtDT = (iso) => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '');
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function dayLabel(iso) {
    const d = new Date(iso);
    const t = new Date();
    const tm = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    return sameDay(d, t) ? `今日 ${fmtDate(iso)}` : sameDay(d, tm) ? `明日 ${fmtDate(iso)}` : fmtDate(iso);
  }
  const STATUS = {
    draft: ['承認待ち', ''], approved: ['予約中', 'good'], posting: ['投稿中', 'warn'], posted: ['投稿済み', 'good'],
    needs_check: ['要確認', 'bad'], failed: ['失敗', 'bad'], rejected: ['却下', '']
  };
  const pill = (s) => `<span class="pill ${(STATUS[s] || ['', ''])[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
  const byId = (id) => posts.find((p) => p.id === id);
  const pendingCount = () => (D.state ? A.pendingActions(D.state, D.actions).length : 0);

  let toastTimer;
  function toast(msg, bad = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2600);
  }

  /* ---------- 画面 ---------- */
  const views = {};
  let current = 'drafts';
  const expanded = new Set();

  function textBlock(p, clamp = true) {
    const long = clamp && !expanded.has(p.id) && p.text.split('\n').length > 4;
    return `<div class="post-text ${long ? 'clamp' : ''}" ${long ? `data-expand="${p.id}"` : ''}>${esc(p.text)}</div>${long ? `<button class="link" style="border:0;background:none;padding:4px 0" data-expand="${p.id}">全文を見る</button>` : ''}`;
  }

  views.drafts = () => {
    const drafts = posts.filter((p) => p.status === 'draft').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const waiting = posts.filter((p) => p.status === 'rejected' && p.regen === 'waiting').length;
    const gen = (D.actions.items || []).filter((a) => a.type === 'generate' && !(D.state.applied || []).includes(a.id));
    return `
      ${justConnected && !STANDALONE ? '<div class="banner good">つながりました。共有ボタン（□に↑）から「ホーム画面に追加」すると、アプリのように使えます。</div>' : ''}
      <div class="card">
        <h2>新しい投稿案</h2>
        <div class="muted" style="font-size:13px">投稿案はPCのClaudeが作ります。PCが閉じていても頼んでおけば、PCが起動したときに作り始めます（10〜20分ほど）。</div>
        ${gen.length ? `<div class="banner" style="margin:10px 0 0">${fmtDT(gen[gen.length - 1].at)} に頼みました。PCが起動したら作り始めます。</div>`
          : `<div class="actions"><button class="btn" data-generate>投稿案を作ってもらう</button></div>`}
      </div>
      ${waiting ? `<div class="banner">作り直し待ちが${waiting}件あります。PCのダッシュボードで「作り直す」を押すと作り直されます。</div>` : ''}
      <div class="sec">承認待ち（${drafts.length}件）</div>
      ${drafts.length ? drafts.map((p) => `
        <div class="card">
          <div class="meta"><span>${esc(p.source || '')}</span><span>${A.countText(p.text)}文字</span>${p.edited ? '<span>手直し済み</span>' : ''}</div>
          ${textBlock(p)}
          <div class="actions">
            <button class="btn primary" data-approve="${p.id}">承認して予約</button>
            <button class="btn" data-edit="${p.id}">手直し</button>
            <button class="btn danger" data-reject="${p.id}">却下</button>
          </div>
        </div>`).join('') : '<div class="empty">承認待ちの投稿案はありません</div>'}`;
  };

  views.schedule = () => {
    const trouble = posts.filter((p) => ['needs_check', 'failed', 'posting'].includes(p.status));
    const scheduled = posts.filter((p) => p.status === 'approved').sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
    let lastDay = '';
    return `
      ${D.state && !D.state.enabled ? '<div class="banner bad">クラウドからの投稿がオフになっています。予約しても投稿されません（PCのダッシュボードの設定で切り替えます）。</div>' : ''}
      ${trouble.length ? `<div class="sec">確認が必要（${trouble.length}件）</div>${trouble.map((p) => `
        <div class="card">
          <div class="meta">${pill(p.status)}<span>${fmtDT(p.scheduled_at)}</span></div>
          ${textBlock(p)}
          ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
          ${p.status === 'posting' ? '<div class="note">いま投稿しています。少し待ってから最新にしてください。</div>' : `<div class="actions">
            ${p.status === 'needs_check' ? `<button class="btn" data-confirm="${p.id}">投稿されていた</button>` : ''}
            <button class="btn primary" data-approve="${p.id}">予約し直す</button>
            <button class="btn" data-unschedule="${p.id}">下書きに戻す</button>
          </div>`}
        </div>`).join('')}` : ''}
      <div class="sec">予約中（${scheduled.length}件）</div>
      ${scheduled.length ? scheduled.map((p) => {
        const day = dayLabel(p.scheduled_at);
        const head = day !== lastDay ? `<div class="sec" style="margin-top:14px">${esc(day)}</div>` : '';
        lastDay = day;
        return `${head}
        <div class="card">
          <div class="meta"><span class="when">${fmtTime(p.scheduled_at)}</span>${pill('approved')}</div>
          ${textBlock(p)}
          <div class="actions">
            <button class="btn" data-approve="${p.id}">時刻変更</button>
            <button class="btn" data-unschedule="${p.id}">取り消し</button>
            <button class="btn" data-postnow="${p.id}">今すぐ投稿</button>
          </div>
        </div>`;
      }).join('') : '<div class="empty">予約中の投稿はありません</div>'}
      <div class="note" style="margin:4px 4px 0">予約は、PCが閉じていてもGitHubから投稿されます。GitHubの混み具合で、数分〜15分ほど遅れることがあります。</div>`;
  };

  views.posted = () => {
    const done = posts.filter((p) => p.status === 'posted').sort((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
    return `<div class="sec">投稿済み（最近30日・${done.length}件）</div>
      ${done.length ? done.map((p) => `
        <div class="card">
          <div class="meta"><span>${fmtDT(p.posted_at)}</span>${p.permalink ? `<a class="link" href="${esc(p.permalink)}" target="_blank" rel="noopener">Threadsで見る</a>` : ''}</div>
          ${textBlock(p)}
        </div>`).join('') : '<div class="empty">まだありません</div>'}`;
  };

  views.settings = () => `
    <div class="card">
      <h2>つながり</h2>
      <dl class="kv">
        <dt>保管場所</dt><dd>${esc(cfg.repo)}</dd>
        <dt>PCが最後に送った時刻</dt><dd>${D.state && D.state.updated_at ? fmtDT(D.state.updated_at) : '—'}</dd>
        <dt>PCにまだ届いていない操作</dt><dd>${pendingCount()}件</dd>
        <dt>この画面を最新にした時刻</dt><dd>${D.loadedAt ? fmtDT(D.loadedAt.toISOString()) : '—'}</dd>
      </dl>
      <div class="note">iPhoneでの操作は、すぐにGitHubからの投稿に反映されます。PCのダッシュボードには、PCが起動したときに（5分以内に）反映されます。</div>
    </div>
    <div class="card">
      <h2>できること・できないこと</h2>
      <ol class="steps">
        <li>承認・予約・時刻変更・取り消し・却下・手直し・今すぐ投稿は、PCが閉じていてもできます</li>
        <li>予約できる時刻は、いつもの投稿時間（${esc(((D.state && D.state.post_times) || []).join('・'))}）か「今すぐ」です。ほかの時刻はPCで選んでください</li>
        <li>新しい投稿案は、PCが起動しているときに作られます</li>
        <li>予約時刻から6時間以上遅れた投稿は、勝手に出さずに「要確認」で止めます</li>
      </ol>
    </div>
    <div class="card">
      <h2>合鍵</h2>
      <div class="muted" style="font-size:13px">Macから受け取った合鍵は、このiPhoneの中にだけ保存されています。iPhoneを人に渡すときや、使わなくなったときは消してください。</div>
      <div class="actions"><button class="btn danger" data-logout>このiPhoneから合鍵を消す</button></div>
    </div>`;

  views.setup = () => `
    <div class="card">
      <h2>はじめに（1回だけ）</h2>
      <ol class="steps">
        <li>Macでダッシュボードを開き、「設定」の <b>iPhoneとつなぐ</b> で <b>QRコードを表示</b> を押す</li>
        <li>iPhoneの <b>カメラ</b> でQRコードを読み、出てきたリンクをタップする（Safariで開きます）</li>
        <li>つながったら、共有ボタンから <b>ホーム画面に追加</b> を押す</li>
      </ol>
      <div class="note">${STANDALONE ? 'ホーム画面から開いたときにつながっていない場合は、いったんこのアプリを消して、SafariでQRコードから開き直してから追加してください。' : 'QRコードが読めないときは、Macで「リンクをコピー」を押し、下に貼り付けてください。'}</div>
      <label class="f" for="setupCode">つなぐためのリンク（QRコードが読めないとき）</label>
      <input class="field" id="setupCode" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://…#c=…">
      <div class="actions"><button class="btn primary block" data-connect>つなぐ</button></div>
    </div>`;

  function render() {
    const setup = !cfg.token;
    document.body.classList.toggle('setup', setup);
    const view = setup ? 'setup' : current;
    for (const el of document.querySelectorAll('.view')) el.classList.toggle('active', el.id === `view-${view}`);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === view);
    const sub = document.getElementById('sub');
    if (setup) sub.textContent = 'GitHubとつなぐ';
    else if (D.error && !D.state) sub.textContent = D.error;
    else if (D.loadedAt) sub.textContent = `${fmtTime(D.loadedAt.toISOString())} 時点${pendingCount() ? `・PCに未反映の操作 ${pendingCount()}件` : ''}`;
    if (!setup && !D.state) {
      document.getElementById(`view-${view}`).innerHTML = D.error ? `<div class="banner bad">${esc(D.error)}</div>` : '<div class="empty">読み込み中…</div>';
    } else {
      document.getElementById(`view-${view}`).innerHTML = views[view]();
    }
    const nDraft = posts.filter((p) => p.status === 'draft').length;
    const nTrouble = posts.filter((p) => ['needs_check', 'failed'].includes(p.status)).length;
    const bd = document.getElementById('badge-drafts');
    bd.hidden = !nDraft; bd.textContent = nDraft;
    const bs = document.getElementById('badge-schedule');
    bs.hidden = !nTrouble; bs.textContent = nTrouble;
  }

  /* ---------- 下から出る入力画面 ---------- */
  const sheet = document.getElementById('sheet');
  function openSheet(html) {
    sheet.querySelector('.sheet-body').innerHTML = html;
    sheet.hidden = false;
  }
  const closeSheet = () => { sheet.hidden = true; };
  const sheetHead = (title) => `<div class="sheet-head"><h2>${esc(title)}</h2><button class="x" data-close aria-label="閉じる">×</button></div>`;

  // 予約の日時を選ぶ（いつもの投稿時間だけ。GitHubの決まった時刻に動くため）
  let pick = null;
  function approveSheet(id) {
    const p = byId(id);
    const times = (D.state.post_times || []).slice().sort();
    const now = new Date();
    const days = [...Array(8)].map((_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
    const slotDate = (day, t) => { const [h, m] = t.split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m); };
    const future = (day, t) => slotDate(day, t).getTime() > Date.now() + 2 * 60000;
    if (!pick || pick.id !== id) {
      let first = null;
      for (const d of days) { const t = times.find((x) => future(d, x)); if (t) { first = { day: d, time: t }; break; } }
      pick = { id, dayIndex: first ? days.findIndex((d) => sameDay(d, first.day)) : 0, time: first ? first.time : null };
    }
    const day = days[pick.dayIndex];
    if (pick.time && !future(day, pick.time)) pick.time = times.find((t) => future(day, t)) || null;
    const selected = pick.time ? slotDate(day, pick.time) : null;
    openSheet(`${sheetHead(p.status === 'approved' ? '時刻を変える' : '承認して予約')}
      <div class="preview post-text">${esc(p.text)}</div>
      <label class="f">日にち</label>
      <div class="chips days">${days.map((d, i) => `<button class="chip ${i === pick.dayIndex ? 'on' : ''}" data-pickday="${i}" ${times.some((t) => future(d, t)) ? '' : 'disabled'}>${i === 0 ? '今日' : i === 1 ? '明日' : ''} ${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})</button>`).join('')}</div>
      <label class="f">時刻</label>
      <div class="chips">${times.map((t) => `<button class="chip ${t === pick.time ? 'on' : ''}" data-picktime="${t}" ${future(day, t) ? '' : 'disabled'}>${t}</button>`).join('')}</div>
      <div class="note">ほかの時刻にしたいときは、PCのダッシュボードで予約してください。</div>
      <div class="sheet-foot">
        <button class="btn" data-postnow="${p.id}">今すぐ投稿</button>
        <button class="btn primary" data-doapprove="${p.id}" ${selected ? '' : 'disabled'}>${selected ? `${fmtDT(selected.toISOString())} に予約` : '日時を選んでください'}</button>
      </div>`);
    pick.selected = selected;
  }

  function editSheet(id) {
    const p = byId(id);
    openSheet(`${sheetHead('手直し')}
      <textarea class="field" id="editText">${esc(p.text)}</textarea>
      <div class="count" id="editCount"></div>
      <div class="note">手直しした内容は、承認したときにフィードバックとして記録され、次の投稿案づくりに活かされます。</div>
      <div class="sheet-foot"><button class="btn" data-close>やめる</button><button class="btn primary" data-doedit="${p.id}">保存</button></div>`);
    updateCount();
  }
  function updateCount() {
    const ta = document.getElementById('editText');
    const c = document.getElementById('editCount');
    if (!ta || !c) return;
    const n = A.countText(ta.value);
    c.textContent = `${n} / ${A.TEXT_LIMIT}文字`;
    c.classList.toggle('over', n > A.TEXT_LIMIT);
  }

  function rejectSheet(id) {
    const p = byId(id);
    openSheet(`${sheetHead('却下')}
      <div class="preview post-text">${esc(p.text)}</div>
      <label class="f" for="rejectReason">却下の理由（次の投稿案づくりに活かします）</label>
      <textarea class="field" id="rejectReason" style="min-height:110px" placeholder="例：口調が自分らしくない／この話はもう書いた"></textarea>
      <label class="check"><input type="checkbox" id="rejectRegen">この投稿を作り直してほしい</label>
      <div class="sheet-foot"><button class="btn" data-close>やめる</button><button class="btn primary" data-doreject="${p.id}">却下する</button></div>`);
  }

  /* ---------- 操作 ---------- */
  let busy = false;
  async function act(action, okMsg, { after } = {}) {
    if (busy) return;
    busy = true;
    try {
      await addAction(action);
      if (after) await after();
      closeSheet();
      compute();
      render();
      toast(okMsg);
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
    }
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('button, [data-expand], [data-close]');
    if (!el) return;
    const d = el.dataset;
    if (d.close !== undefined) return closeSheet();
    if (d.view) { current = d.view; window.scrollTo(0, 0); return render(); }
    if (d.expand) { expanded.add(d.expand); return render(); }
    if (d.approve) return approveSheet(d.approve);
    if (d.pickday) { pick.dayIndex = Number(d.pickday); return approveSheet(pick.id); }
    if (d.picktime) { pick.time = d.picktime; return approveSheet(pick.id); }
    if (d.doapprove) {
      if (!pick || !pick.selected) return;
      return act({ type: 'approve', post_id: d.doapprove, scheduled_at: pick.selected.toISOString() }, `${fmtDT(pick.selected.toISOString())} に予約しました`);
    }
    if (d.postnow) {
      if (!confirm('今すぐThreadsに投稿します。よろしいですか？')) return;
      return act({ type: 'post_now', post_id: d.postnow }, '投稿を始めました。1〜数分で投稿されます', { after: runPoster });
    }
    if (d.edit) return editSheet(d.edit);
    if (d.doedit) {
      const text = document.getElementById('editText').value.trim();
      const problem = A.checkText(text);
      if (problem) return toast(problem, true);
      return act({ type: 'edit', post_id: d.doedit, text }, '保存しました');
    }
    if (d.reject) return rejectSheet(d.reject);
    if (d.doreject) {
      const reason = document.getElementById('rejectReason').value.trim();
      if (!reason) return toast('却下の理由を書いてください', true);
      return act({ type: 'reject', post_id: d.doreject, reason, regen: document.getElementById('rejectRegen').checked }, '却下しました');
    }
    if (d.unschedule) {
      if (!confirm('予約を取り消して、下書き（承認待ち）に戻します。よろしいですか？')) return;
      return act({ type: 'unschedule', post_id: d.unschedule }, '予約を取り消しました');
    }
    if (d.confirm) {
      if (!confirm('Threadsアプリで、この投稿が出ていることを確かめましたか？「投稿済み」にします')) return;
      return act({ type: 'confirm_posted', post_id: d.confirm }, '投稿済みにしました');
    }
    if (d.generate !== undefined) return act({ type: 'generate' }, 'PCが起動したら投稿案を作り始めます');
    if (d.logout !== undefined) {
      if (!confirm('このiPhoneから合鍵を消します。もう一度使うときは、合鍵を作り直して登録します。よろしいですか？')) return;
      cfg = {};
      saveCfg(cfg);
      history.replaceState(null, '', location.pathname);
      D.state = null;
      return render();
    }
    if (d.connect !== undefined) {
      const found = readConnectCode(document.getElementById('setupCode').value);
      if (!found) return toast('リンクが読めません。Macの「リンクをコピー」で出た文字を、全部貼り付けてください', true);
      cfg = { repo: found.repo, token: found.token };
      el.disabled = true;
      try {
        const s = await getFile('data/state.json');
        if (!s) throw new Error('保管場所に投稿一覧が見つかりません。PCのダッシュボードを一度開いてから、もう一度お試しください');
        if (!saveCfg(cfg)) toast('このiPhoneに保存できませんでした（プライベートブラウズでは保存されません）', true);
        current = 'drafts';
        if (!STANDALONE) history.replaceState(null, '', `${location.pathname}#c=${found.code || ''}`);
        await load();
        toast('つながりました');
      } catch (err) {
        cfg = {};
        toast(err.message, true);
        render();
      } finally {
        el.disabled = false;
      }
    }
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'editText') updateCount(); });
  document.getElementById('refreshBtn').addEventListener('click', () => (cfg.token ? load() : null));

  // アプリに戻ってきたときと、開いている間は2分ごとに最新にする
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cfg.token && sheet.hidden) load({ quiet: true }); });
  setInterval(() => { if (document.visibilityState === 'visible' && cfg.token && sheet.hidden) load({ quiet: true }); }, 120000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  render();
  if (cfg.token) load();
})();
