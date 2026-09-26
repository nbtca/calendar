import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = { EVENTS_CALENDAR_URL: "https://calendar.example/events.ics" };
const schoolEnv = {
  ...env,
  ASSETS: {
    fetch: async () =>
      new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
        headers: { ETag: '"school-v1"', "Content-Type": "text/calendar" },
      }),
  },
};

test("answers preflight without fetching the calendar", async () => {
  const response = await worker.fetch(
    new Request("https://ical.example/events.ics", { method: "OPTIONS" }),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("rejects unsupported methods", async () => {
  const response = await worker.fetch(
    new Request("https://ical.example/events.ics", { method: "POST" }),
    env,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD, OPTIONS");
});

test("serves the school calendar through the static asset binding", async () => {
  const response = await worker.fetch(
    new Request("https://ical.example/school.ics"),
    schoolEnv,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"school-v1"');
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(await response.text(), /BEGIN:VCALENDAR/);
});

test("preserves static asset not-modified responses", async () => {
  const conditionalEnv = {
    ...env,
    ASSETS: {
      fetch: async () =>
        new Response(null, {
          status: 304,
          headers: { ETag: '"school-v1"' },
        }),
    },
  };
  const response = await worker.fetch(
    new Request("https://ical.example/school.ics", {
      headers: { "If-None-Match": '"school-v1"' },
    }),
    conditionalEnv,
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("ETag"), '"school-v1"');
});

test("streams successful upstream calendar responses", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { ETag: '"calendar-v1"', "Content-Type": "text/calendar" },
    }),
  );
  const response = await worker.fetch(
    new Request("https://ical.example/events.ics"),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"calendar-v1"');
  assert.equal(response.headers.get("Content-Type"), "text/calendar; charset=utf-8");
  assert.match(await response.text(), /BEGIN:VCALENDAR/);
});

test("supports conditional requests using the upstream ETag", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { ETag: '"calendar-v1"', "Content-Type": "text/calendar" },
    }),
  );
  const response = await worker.fetch(
    new Request("https://ical.example/events.ics", {
      headers: { "If-None-Match": '"calendar-v1"' },
    }),
    env,
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
});

test("maps upstream errors to a gateway error", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("no", { status: 503 }));
  const response = await worker.fetch(
    new Request("https://ical.example/events.ics"),
    env,
  );
  assert.equal(response.status, 502);
});

test("rejects successful non-calendar upstream responses", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    new Response("login page", {
      headers: { "Content-Type": "text/html" },
    }),
  );
  const response = await worker.fetch(
    new Request("https://ical.example/events.ics"),
    env,
  );
  assert.equal(response.status, 502);
});

function stubCache(seed) {
  const store = new Map(seed ? [[seed.url, seed.response]] : []);
  globalThis.caches = {
    default: {
      match: async (key) => store.get(String(key))?.clone(),
      put: async (key, response) => void store.set(String(key), response),
    },
  };
  return store;
}

test("serves the last good calendar when the source fails", async (context) => {
  const store = stubCache();
  context.after(() => delete globalThis.caches);
  context.mock.method(globalThis, "fetch", async () =>
    new Response("BEGIN:VCALENDAR\r\nGOOD\r\nEND:VCALENDAR\r\n", {
      headers: { ETag: '"v1"', "Content-Type": "text/calendar" },
    }),
  );

  const first = await worker.fetch(new Request("https://ical.example/events.ics"), env);
  assert.equal(first.status, 200);
  assert.equal(store.size, 1);

  context.mock.restoreAll();
  context.mock.method(globalThis, "fetch", async () => new Response("no", { status: 503 }));

  const second = await worker.fetch(new Request("https://ical.example/events.ics"), env);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("X-Calendar-Stale"), "1");
  assert.match(await second.text(), /GOOD/);
});

test("still reports a gateway error when nothing was ever cached", async (context) => {
  stubCache();
  context.after(() => delete globalThis.caches);
  context.mock.method(globalThis, "fetch", async () => new Response("no", { status: 503 }));

  const response = await worker.fetch(new Request("https://ical.example/events.ics"), env);
  assert.equal(response.status, 502);
});

function projectNode() {
  return {
    id: "PVTI_project",
    updatedAt: "2026-09-24T00:00:00Z",
    content: {
      __typename: "Issue",
      title: "工牌形态和制式确定",
      url: "https://github.com/nbtca/Roadmap/issues/80",
      number: 80,
      repository: { nameWithOwner: "nbtca/Roadmap" },
    },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldDateValue",
          date: "2026-09-25",
          field: { name: "Start date" },
        },
        {
          __typename: "ProjectV2ItemFieldDateValue",
          date: "2026-09-30",
          field: { name: "End date" },
        },
      ],
    },
  };
}

function projectEnv() {
  return { ...env, GITHUB_TOKEN: "github-token" };
}

test("generates the project calendar from GitHub project dates", async (context) => {
  let requested;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requested = String(url);
    assert.equal(options.headers.Authorization, "Bearer github-token");
    return Response.json({
      data: {
        organization: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [projectNode()],
            },
          },
        },
      },
    });
  });
  const response = await worker.fetch(
    new Request("https://ical.example/project.ics"),
    projectEnv(),
  );
  assert.equal(requested, "https://api.github.com/graphql");
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Disposition"),
    "inline; filename=nbtca-project.ics",
  );
  const body = await response.text();
  assert.match(body, /X-WR-CALNAME:NBTCA 项目推进/);
  assert.match(body, /SUMMARY:工牌形态和制式确定/);
  assert.match(body, /DTSTART;VALUE=DATE:20260925/);
  assert.match(body, /DTEND;VALUE=DATE:20261001/);
  assert.match(body, /UID:PVTI_project@project\.nbtca\.space/);
});

test("does not reuse the events calendar when project generation fails", async (context) => {
  const store = stubCache();
  context.after(() => delete globalThis.caches);
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("github.com")) return new Response("no", { status: 503 });
    return new Response("BEGIN:VCALENDAR\r\nEVENTS\r\nEND:VCALENDAR\r\n", {
      headers: { "Content-Type": "text/calendar" },
    });
  });

  const events = await worker.fetch(new Request("https://ical.example/events.ics"), projectEnv());
  assert.equal(events.status, 200);
  assert.match(await events.text(), /EVENTS/);

  const project = await worker.fetch(new Request("https://ical.example/project.ics"), projectEnv());
  assert.equal(project.status, 502);
  assert.equal(store.size, 1);
});

test("reports a configuration error when the project token is absent", async () => {
  const response = await worker.fetch(new Request("https://ical.example/project.ics"), env);
  assert.equal(response.status, 503);
});
function mockUpstream(context, headers = {}) {
  context.mock.method(globalThis, "fetch", async () =>
    new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "Content-Type": "text/calendar", ...headers },
    }),
  );
}

test("derives a stable ETag when the upstream sends none", async (context) => {
  mockUpstream(context);
  const first = await worker.fetch(new Request("https://ical.example/"), env);
  const second = await worker.fetch(new Request("https://ical.example/"), env);
  assert.match(first.headers.get("ETag"), /^"[0-9a-f]{32}"$/);
  assert.equal(first.headers.get("ETag"), second.headers.get("ETag"));
});

test("answers a matching If-None-Match with 304", async (context) => {
  mockUpstream(context);
  const { headers } = await worker.fetch(new Request("https://ical.example/"), env);
  const response = await worker.fetch(
    new Request("https://ical.example/", { headers: { "If-None-Match": headers.get("ETag") } }),
    env,
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
});

test("answers an unchanged If-Modified-Since with 304", async (context) => {
  mockUpstream(context, { "Last-Modified": "Sat, 26 Sep 2026 12:00:00 GMT" });
  const unchanged = await worker.fetch(
    new Request("https://ical.example/", {
      headers: { "If-Modified-Since": "Sat, 26 Sep 2026 12:00:00 GMT" },
    }),
    env,
  );
  const older = await worker.fetch(
    new Request("https://ical.example/", {
      headers: { "If-Modified-Since": "Fri, 25 Sep 2026 12:00:00 GMT" },
    }),
    env,
  );
  assert.equal(unchanged.status, 304);
  assert.equal(older.status, 200);
});

test("asks the runtime to gzip only for clients that accept it", async (context) => {
  mockUpstream(context);
  const gzip = await worker.fetch(
    new Request("https://ical.example/", { headers: { "Accept-Encoding": "br, gzip" } }),
    env,
  );
  const plain = await worker.fetch(new Request("https://ical.example/"), env);
  assert.equal(gzip.headers.get("Content-Encoding"), "gzip");
  assert.equal(plain.headers.get("Content-Encoding"), null);
  assert.equal(plain.headers.get("Vary"), "Accept-Encoding");
});
