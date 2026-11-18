/**
 * Service Worker: 页面壳离线缓存
 * 策略:
 *   - navigation: network-first (超时回退缓存壳并在后台刷新)
 *   - 同源静态资源: stale-while-revalidate (优先返回缓存并后台更新)
 *   - 跨域请求 (数据接口与云存储): 直连不缓存
 */

var SW_VERSION = "2026-11-04.1";
var CACHE_PREFIX = "steward-shell-";
var CACHE_NAME = CACHE_PREFIX + SW_VERSION;
var SHELL_INDEX = "./index.html";
var NAV_TIMEOUT_MS = 3000;

/* 预缓存静态资产清单（页面壳及图标） */
var SHELL_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./apple-touch-icon-precomposed.png"
];

/* 静态资源白名单匹配规则 */
var STATIC_RE = /\.(?:png|ico|svg|webmanifest)$/i;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(SHELL_ASSETS.map(function (url) {
        /* 强制通过网络获取最新资源，避免加载 HTTP 缓存 */
        return fetch(new Request(url, { cache: "reload" })).then(function (res) {
          if (res && res.ok) return cache.put(url, res);
        }).catch(function () {
          /* 单个静态资源失败不阻断 SW 安装 */
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  /* 跨域请求（数据接口及远程存储）直连不缓存 */
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(navigationHandler(req));
    return;
  }
  if (STATIC_RE.test(url.pathname) || url.pathname.endsWith("/manifest.json")) {
    event.respondWith(staticHandler(req, event));
  }
  /* 其余同源请求（含 sw.js 自身、_headers 之类）不拦，走浏览器默认行为 */
});

/* network-first: 优先网络请求，超时或离线回退到缓存壳并在后台刷新 */
function navigationHandler(req) {
  return caches.open(CACHE_NAME).then(function (cache) {
    var path = "";
    try {
      path = new URL(req.url).pathname;
    } catch (e) {}
    /* 仅根路径与 index.html 允许写入离线壳缓存 */
    var isShell = path.endsWith("/") || path.endsWith("/index.html");

    var network = fetch(req).then(function (res) {
      if (res && res.ok && res.type !== "opaque" && isShell) {
        cache.put(SHELL_INDEX, res.clone()).catch(function () {});
      }
      return res;
    }).catch(function (err) {
      return err;
    });

    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        resolve(null);
      }, NAV_TIMEOUT_MS);
    });

    return Promise.race([network, timeout]).then(function (winner) {
      if (winner && !(winner instanceof Error)) return winner;

      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return cache.match(SHELL_INDEX);
      }).then(function (hit) {
        if (hit) return hit;
        /* 缓存里也没有：只能等那次还没结束的网络请求 */
        return network.then(function (late) {
          if (late && !(late instanceof Error)) return late;
          return offlinePage();
        });
      });
    });
  });
}

/* stale-while-revalidate: 缓存命中优先返回，并在后台发起网络更新 */
function staticHandler(req, event) {
  return caches.open(CACHE_NAME).then(function (cache) {
    var refresh = fetch(req).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone()).catch(function () {});
      return res;
    }).catch(function () {
      return null;
    });

    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        event.waitUntil(refresh);
        return hit;
      }
      return refresh.then(function (fresh) {
        return fresh || offlinePage();
      });
    });
  });
}

function offlinePage() {
  var html =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>暂时连不上网络</title>' +
    '<body style="margin:0;padding:48px 24px;background:#0b0d11;color:#e6edf3;' +
    'font:16px/1.7 system-ui,-apple-system,sans-serif">' +
    '<h1 style="font-size:18px;margin:0 0 12px">暂时连不上网络</h1>' +
    '<p style="color:#8b98a9;margin:0">这个页面还没缓存到本地。' +
    '等网络恢复后刷新一次，之后即使网络很差也能直接打开。</p></body></html>';
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}
