const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const PROXY_PATHS = new Set(["/", "/events.ics"]);

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
  async fetch(request, env) {
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
          cacheTtl: 300,
        },
      });

      if (!upstream.ok) {
        return plainText("Calendar source unavailable", 502);
      }

      const headers = new Headers();
      for (const name of ["ETag", "Last-Modified"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }

      const contentType = upstream.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("text/calendar")) {
        return plainText("Calendar source returned an unexpected response", 502);
      }

      const filename = pathname === "/" ? "nbtca.ics" : "nbtca-events.ics";
      headers.set("Content-Type", "text/calendar; charset=utf-8");
      headers.set("Content-Disposition", `inline; filename=${filename}`);
      headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        headers.set(name, value);
      }

      const etag = headers.get("ETag");
      if (etag && request.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers });
      }

      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: 200,
        headers,
      });
    } catch {
      return plainText("Calendar source unavailable", 502);
    }
  },
};
