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
