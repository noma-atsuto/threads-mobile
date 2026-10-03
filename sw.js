// 画面の部品だけを保存して、電波が弱くてもすぐ開けるようにする。
// GitHubとのやり取り（予約の中身・合鍵）は保存しない（このサイト以外への通信には手を出さない）
const CACHE = "threads-mobile-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "actions.js", "icon-180.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// 新しい画面を優先し、つながらないときだけ保存済みを使う
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
