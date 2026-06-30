/* ═══════════════════════════════════════════════════════════
   Sanctuary Of Reed — Service Worker
   策略：
   1. CACHE_NAME 帶版本字串 → 每次你修改部署內容後，
      瀏覽器都會偵測到 sw.js 本身位元組變動而觸發更新。
      （不需要你手動改版本號也沒關係，見下方第 2 點）
   2. 對「同源頁面資源」一律採用 network-first：
      只要使用者裝置有網路，就一定拿最新版本，
      Cache 只作為離線時的備援，不會卡住舊版內容。
   3. install 時立刻 skipWaiting、activate 時立刻 clients.claim，
      讓新 SW 不需要使用者關閉所有分頁就能接管，
      搭配 index.html 內的偵測程式碼，背景更新後跳提示。
   4. 完全略過 Firebase / 第三方 API 與非 GET 請求，
      避免影響 Firestore 即時連線。
═══════════════════════════════════════════════════════════ */

const CACHE_NAME = 'sanctuary-of-reed-v1';

// 開站必要資源（離線備援用）
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => {}) // 離線首次安裝或單一資源失敗不阻擋安裝
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只處理同源 GET 請求；Firebase / Google Fonts / 第三方 API 一律放行不快取
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
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

// 讓頁面可以呼叫 skipWaiting（搭配前端「發現新版本」提示按鈕）
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
