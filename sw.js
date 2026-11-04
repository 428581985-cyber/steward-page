/* Service Worker —— 页面壳离线缓存（2026-11-04）
 *
 * 背景：站点托管在 Cloudflare Pages（steward-3t9.pages.dev），校园网/代理下经常
 *   直接返回 000，或握手卡十几秒。实测同期 github.io 15/15 次全通（0.6~1.0s），
 *   pages.dev 5 次里 3 次 000。页面是**单个 ~918KB 全内联 HTML**（JS/CSS 全在里面），
 *   所以只要拿到过一次响应，整站就能离线打开。
 *
 * 策略（与「五层缓存」那轮教训兼容 —— 缓存的只是**页面壳**，不是数据）：
 *   · navigation          → network-first，3 秒不回来就吐缓存壳，网络回来后后台继续更新
 *   · 同源静态（图标 / manifest.json）→ cache-first + 后台更新（stale-while-revalidate）
 *   · 跨域请求（COS 数据、Worker 接口）→ **一律不拦**，永远直连，绝不进缓存
 *   · 缓存名带版本号，activate 时清掉所有旧版本
 *
 * ★ 改这个文件必须同时改 SW_VERSION：浏览器靠**脚本字节**判断要不要装新 SW，
 *   只改策略不升版本号，用户会永远停在旧逻辑上。
 * ★ v2.html 是「绕过缓存」的应急通道（见 build.py 的说明），故意**不进**静态白名单；
 *   但它是 navigation，仍会走 network-first（离线时落到缓存的 index.html，可接受）。
 * ★ 只接管 https + 同源。file:// 打开时浏览器根本不注册 SW，注册代码那侧有 try/catch。
 */

var SW_VERSION = "2026-11-04.1";
var CACHE_PREFIX = "steward-shell-";
var CACHE_NAME = CACHE_PREFIX + SW_VERSION;
var SHELL_INDEX = "./index.html";
var NAV_TIMEOUT_MS = 3000;

/* 预缓存清单：只放壳与小文件。不放 "./"（它和 index.html 是同一份 918KB，
   缓存两份纯属浪费空间）。单个失败不阻断安装 —— 校园网下经常有零星 000。 */
var SHELL_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./apple-touch-icon-precomposed.png"
];

/* 静态资源：只认这几类。JS/CSS 全内联在 index.html 里，没有外链需要缓存。 */
var STATIC_RE = /\.(?:png|ico|svg|webmanifest)$/i;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(SHELL_ASSETS.map(function (url) {
        /* cache: "reload" —— 宁可多走一次网络，也不要把 HTTP 缓存里的旧壳装进来 */
        return fetch(new Request(url, { cache: "reload" })).then(function (res) {
          if (res && res.ok) return cache.put(url, res);
        }).catch(function () {
          /* 单个文件拿不到就跳过：SW 装起来比装得全更重要 */
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
  /* 跨域（COS 数据、Worker/SCF 接口）一概不拦：数据必须实时，离线时让它自然失败 */
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

/* network-first：先抢网络，超时/失败用缓存的壳顶上。
   后台那次 fetch 不会因为超时被取消 —— 一旦成功会顺手把壳刷新，下次更快。 */
function navigationHandler(req) {
  return caches.open(CACHE_NAME).then(function (cache) {
    var path = "";
    try {
      path = new URL(req.url).pathname;
    } catch (e) {}
    /* 只有根路径与 index.html 才允许覆盖壳缓存；v2.html 的响应不能污染它 */
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

/* cache-first + 后台更新：图标/manifest 变了最多迟一次访问，
   但永远不会因为网络抖动而让页面缺图标。 */
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
