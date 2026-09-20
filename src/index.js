const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const PROXY_PATHS = new Set(["/", "/events.ics"]);

const LAST_GOOD = "https://calendar.nbtca.invalid/last-good";

function edgeCache() {
  try {
    return globalThis.caches?.default ?? null;
  } catch {
    return null;
  }
}

function remember(body, headers, ctx) {
  const cache = edgeCache();
  if (!cache) return;
  const keep = new Headers(headers);
  keep.set("Cache-Control", "public, max-age=86400");
  const stored = cache.put(LAST_GOOD, new Response(body, { headers: keep })).catch(() => {});
  ctx?.waitUntil?.(stored);
}

async function serveLastGood(method) {
  const cache = edgeCache();
  const cached = cache ? await cache.match(LAST_GOOD).catch(() => null) : null;
  if (!cached) return plainText("Calendar source unavailable", 502);

  const headers = new Headers(cached.headers);
  headers.set("Cache-Control", "public, max-age=60");
  headers.set("X-Calendar-Stale", "1");
  return new Response(method === "HEAD" ? null : cached.body, { status: 200, headers });
}

function plainText(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return plainText("Method Not Allowed", 405, {
        Allow: "GET, HEAD, OPTIONS",
      });
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/school.ics") {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status === 304) {
        const headers = new Headers(asset.headers);
        for (const [name, value] of Object.entries(CORS_HEADERS)) {
          headers.set(name, value);
        }
        return new Response(null, { status: 304, headers });
      }
      if (!asset.ok) return plainText("School calendar unavailable", 502);

      const headers = new Headers(asset.headers);
      headers.set("Content-Type", "text/calendar; charset=utf-8");
      headers.set("Content-Disposition", "inline; filename=nbtca-school.ics");
      headers.set("Cache-Control", "public, max-age=300, must-revalidate");
      headers.set("X-Content-Type-Options", "nosniff");
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        headers.set(name, value);
      }

      return new Response(request.method === "HEAD" ? null : asset.body, {
        status: 200,
        headers,
      });
    }

    if (!PROXY_PATHS.has(pathname)) {
      return plainText("Not Found", 404);
    }

    if (!env.EVENTS_CALENDAR_URL) {
      return plainText("Calendar source is not configured", 503);
    }

    try {
      const upstream = await fetch(env.EVENTS_CALENDAR_URL, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: { "200-299": 900, "429": 900, "500-599": 0 },
        },
      });

      if (!upstream.ok) {
        return serveLastGood(request.method);
      }

      const headers = new Headers();
      for (const name of ["ETag", "Last-Modified"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }

      const contentType = upstream.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("text/calendar")) {
        return serveLastGood(request.method);
      }

      const filename = pathname === "/" ? "nbtca.ics" : "nbtca-events.ics";
      headers.set("Content-Type", "text/calendar; charset=utf-8");
      headers.set("Content-Disposition", `inline; filename=${filename}`);
      headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        headers.set(name, value);
      }

      const calendar = await upstream.text();
      remember(calendar, headers, ctx);

      const etag = headers.get("ETag");
      if (etag && request.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers });
      }

      return new Response(request.method === "HEAD" ? null : calendar, {
        status: 200,
        headers,
      });
    } catch {
      return serveLastGood(request.method);
    }
  },
};
