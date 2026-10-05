/* ═══════════════════════════════════════════════════════════
   Sanctuary Of Reed — Service Worker（離線版）
   策略：
   1. 同源頁面資源（index.html 等）：network-first，
      有網路就拿最新版；網路失敗或超過 4 秒沒回應 → 退回快取，所以離線也能開。
   2. 第三方「程式庫 / 字型」（Firebase SDK、Google Fonts）：
      快取後離線使用。Firebase 檔案網址帶版本號，用 cache-first；
      Google Fonts 用 stale-while-revalidate。
   3. Firestore / Auth 的 API 請求（googleapis.com 其他網域）一律放行不攔截，
      日記資料的離線由 Firestore 自己的 IndexedDB 快取負責。
   4. install 時 skipWaiting、activate 時 clients.claim，
      搭配 index.html 內的偵測程式碼，背景更新後自動套用。
═══════════════════════════════════════════════════════════ */

const CACHE_NAME = 'sanctuary-of-reed-v13';   // 同源資源
const EXT_CACHE  = 'sanctuary-ext-v1';        // 第三方程式庫與字型（跨版本保留）

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
];

// 離線必要的 Firebase SDK 入口（需與 index.html 的 import 網址一致）
const FIREBASE_ENTRIES = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;500;700&family=Noto+Sans+TC:wght@300;400;500&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap';

const isExtLib  = (u) => u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/');
const isFont    = (u) => u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';

/* 抓取 ES module 並遞迴快取它 import / export 的其他模組 */
async function cacheModuleTree(cache, url, seen = new Set()) {
  if (seen.has(url)) return;
  seen.add(url);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return;
    await cache.put(url, res.clone());
  }
  const text = await res.clone().text();
  const re = /(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?["']([^"']+)["']/g;
  let m;
  const deps = [];
  while ((m = re.exec(text))) {
    try { deps.push(new URL(m[1], url).href); } catch (_) {}
  }
  await Promise.all(deps.filter((d) => d.startsWith('https://www.gstatic.com/firebasejs/'))
    .map((d) => cacheModuleTree(cache, d, seen).catch(() => {})));
}

async function precacheExternal() {
  const cache = await caches.open(EXT_CACHE);
  await Promise.all(FIREBASE_ENTRIES.map((u) => cacheModuleTree(cache, u).catch(() => {})));
  try {
    const css = await fetch(FONT_CSS);
    if (css.ok) {
      await cache.put(FONT_CSS, css.clone());
      // 字型檔（woff2）：解析 CSS 內的網址一併快取
      const text = await css.text();
      const urls = [...text.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
      await Promise.all(urls.map((u) =>
        fetch(u).then((r) => r.ok && cache.put(u, r)).catch(() => {})));
    }
  } catch (_) {}
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {}),
    precacheExternal().catch(() => {}),   // 離線首次安裝或單一資源失敗不阻擋安裝
  ]));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([CACHE_NAME, EXT_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (isExtLib(url)) {
    event.respondWith(cacheFirst(req));
  } else if (isFont(url)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // 其他跨網域請求（Firestore / Auth API 等）不攔截
});

function fetchWithTimeout(req, ms, init) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req, init).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(req) {
  try {
    // 有快取時最多等 4 秒（訊號很差時別讓人一直白畫面）；沒有快取就照常等
    const hasCache = await caches.match(req, { ignoreSearch: true });
    const fresh = hasCache
      ? await fetchWithTimeout(req, 4000, { cache: 'no-store' })
      : await fetch(req, { cache: 'no-store' });
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    // 導覽請求離線時退回首頁快取
    if (req.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(EXT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(EXT_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) { update.catch(() => {}); return hit; }
  const res = await update;
  if (res) return res;
  return Response.error();
}

// 讓頁面可以呼叫 skipWaiting（搭配前端「發現新版本」提示按鈕）
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
