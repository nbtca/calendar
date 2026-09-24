const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const FEEDS = {
  "/": {
    source: "EVENTS_CALENDAR_URL",
    filename: "nbtca.ics",
    cacheKey: "https://calendar.nbtca.invalid/last-good-events",
  },
  "/events.ics": {
    source: "EVENTS_CALENDAR_URL",
    filename: "nbtca-events.ics",
    cacheKey: "https://calendar.nbtca.invalid/last-good-events",
  },
  "/project.ics": {
    source: "PROJECT_CALENDAR_URL",
    filename: "nbtca-project.ics",
    cacheKey: "https://calendar.nbtca.invalid/last-good-project",
  },
};

function edgeCache() {
  try {
    return globalThis.caches?.default ?? null;
  } catch {
    return null;
  }
}

function remember(cacheKey, body, headers, ctx) {
  const cache = edgeCache();
  if (!cache) return;
  const keep = new Headers(headers);
  keep.set("Cache-Control", "public, max-age=86400");
  const stored = cache.put(cacheKey, new Response(body, { headers: keep })).catch(() => {});
  ctx?.waitUntil?.(stored);
}

async function serveLastGood(cacheKey, method) {
  const cache = edgeCache();
  const cached = cache ? await cache.match(cacheKey).catch(() => null) : null;
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

async function proxyCalendar(request, sourceUrl, filename, cacheKey, ctx) {
  if (!sourceUrl) return plainText("Calendar source is not configured", 503);

  try {
    const upstream = await fetch(sourceUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": 900, "429": 900, "500-599": 0 },
      },
    });

    if (!upstream.ok) return serveLastGood(cacheKey, request.method);

    const headers = new Headers();
    for (const name of ["ETag", "Last-Modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    const contentType = upstream.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("text/calendar")) {
      return serveLastGood(cacheKey, request.method);
    }

    headers.set("Content-Type", "text/calendar; charset=utf-8");
    headers.set("Content-Disposition", `inline; filename=${filename}`);
    headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      headers.set(name, value);
    }

    const calendar = await upstream.text();
    remember(cacheKey, calendar, headers, ctx);

    const etag = headers.get("ETag");
    if (etag && request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(request.method === "HEAD" ? null : calendar, {
      status: 200,
      headers,
    });
  } catch {
    return serveLastGood(cacheKey, request.method);
  }
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

    const feed = FEEDS[pathname];
    if (!feed) return plainText("Not Found", 404);
    return proxyCalendar(request, env[feed.source], feed.filename, feed.cacheKey, ctx);
  },
};
