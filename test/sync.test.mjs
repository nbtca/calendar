import assert from "node:assert/strict";
import test from "node:test";
import { diffCalendar, readProjectItem, toDesiredEvent } from "../sync/src/plan.js";
import { syncProjectCalendar } from "../sync/src/sync.js";

const env = {
  GITHUB_TOKEN: "github-token",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  GOOGLE_CALENDAR_ID: "calendar-id",
  GITHUB_PROJECT_OWNER: "nbtca",
  GITHUB_PROJECT_NUMBER: "5",
};

function issueNode(id, title, start, end, status = "Todo") {
  const nodes = [];
  if (start) {
    nodes.push({
      __typename: "ProjectV2ItemFieldDateValue",
      date: start,
      field: { name: "Start date" },
    });
  }
  if (end) {
    nodes.push({
      __typename: "ProjectV2ItemFieldDateValue",
      date: end,
      field: { name: "End date" },
    });
  }
  if (status) {
    nodes.push({
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: status,
      field: { name: "Status" },
    });
  }
  return {
    id,
    content: {
      __typename: "Issue",
      title,
      url: `https://github.com/nbtca/Roadmap/issues/${id}`,
      number: 80,
      repository: { nameWithOwner: "nbtca/Roadmap" },
    },
    fieldValues: { nodes },
  };
}

function markedEvent(id, itemId, summary, start, end, description) {
  return {
    id,
    summary,
    description,
    start: { date: start },
    end: { date: end },
    transparency: "transparent",
    extendedProperties: {
      private: { githubItemId: itemId, githubProject: "nbtca/projects/5" },
    },
  };
}

test("keeps an inclusive project end date and a one-day event when only one date is set", () => {
  const ranged = toDesiredEvent(
    {
      itemId: "PVTI_range",
      title: "工牌形态和制式确定",
      url: "https://github.com/nbtca/Roadmap/issues/80",
      number: 80,
      repository: "nbtca/Roadmap",
      status: "Todo",
      start: "2026-09-25",
      end: "2026-09-30",
    },
    "nbtca",
    5,
  );
  assert.equal(ranged.startDate, "2026-09-25");
  assert.equal(ranged.endDateExclusive, "2026-10-01");
  assert.match(ranged.description, /Status: Todo/);
  assert.match(ranged.description, /https:\/\/github.com\/orgs\/nbtca\/projects\/5/);

  const deadline = toDesiredEvent(
    {
      itemId: "PVTI_day",
      title: "截止",
      url: null,
      number: null,
      repository: null,
      status: null,
      start: null,
      end: "2026-05-31",
    },
    "nbtca",
    5,
  );
  assert.equal(deadline.startDate, "2026-05-31");
  assert.equal(deadline.endDateExclusive, "2026-06-01");
});

test("reads only project items that have a start or end date", () => {
  assert.equal(readProjectItem(issueNode("PVTI_empty", "没有日期", null, null)), null);
  const item = readProjectItem(issueNode("PVTI_dated", "有日期", "2026-09-22", null, "In Progress"));
  assert.equal(item.start, "2026-09-22");
  assert.equal(item.end, null);
  assert.equal(item.status, "In Progress");
});

test("plans creates, updates, and deletes without touching other calendars' events", () => {
  const desired = toDesiredEvent(
    {
      itemId: "PVTI_keep",
      title: "新标题",
      url: "https://github.com/nbtca/Roadmap/issues/80",
      number: 80,
      repository: "nbtca/Roadmap",
      status: "Todo",
      start: "2026-09-25",
      end: "2026-09-30",
    },
    "nbtca",
    5,
  );
  const created = toDesiredEvent(
    {
      itemId: "PVTI_new",
      title: "新建",
      url: "https://github.com/nbtca/Roadmap/issues/81",
      number: 81,
      repository: "nbtca/Roadmap",
      status: "Todo",
      start: "2026-09-30",
      end: "2026-10-10",
    },
    "nbtca",
    5,
  );
  const invalid = toDesiredEvent(
    {
      itemId: "PVTI_bad",
      title: "日期颠倒",
      url: null,
      number: null,
      repository: null,
      status: null,
      start: "2026-10-02",
      end: "2026-10-01",
    },
    "nbtca",
    5,
  );
  const plan = diffCalendar(
    [desired, created, invalid],
    [
      markedEvent("event-keep", "PVTI_keep", "旧标题", "2026-09-25", "2026-10-01", "old"),
      markedEvent("event-bad", "PVTI_bad", "日期颠倒", "2026-10-01", "2026-10-02", "old"),
      markedEvent("event-stale", "PVTI_gone", "已移除", "2026-01-01", "2026-01-02", "old"),
      markedEvent("event-dup", "PVTI_keep", "重复", "2026-09-25", "2026-10-01", "old"),
      { id: "manual", summary: "手工日程", start: { date: "2026-09-01" }, end: { date: "2026-09-02" } },
      markedEvent("other-project", "PVTI_other", "别的项目", "2026-09-01", "2026-09-02", "old"),
    ].map((event, index) =>
      index === 5
        ? {
            ...event,
            extendedProperties: {
              private: { ...event.extendedProperties.private, githubProject: "nbtca/projects/9" },
            },
          }
        : event,
    ),
    "nbtca/projects/5",
  );

  assert.deepEqual(plan.create.map((event) => event.itemId), ["PVTI_new"]);
  assert.deepEqual(plan.update.map((event) => event.eventId), ["event-keep"]);
  assert.deepEqual(
    plan.remove.map((event) => event.eventId).sort(),
    ["event-dup", "event-stale"],
  );
  assert.deepEqual(plan.invalid.map((event) => event.itemId), ["PVTI_bad"]);
});

test("refuses to run without credentials", async () => {
  await assert.rejects(
    () => syncProjectCalendar({}),
    /Missing sync configuration: GITHUB_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID/,
  );
});

test("writes only calendar changes and pages through both APIs", async () => {
  const calls = [];
  const keep = issueNode("PVTI_keep", "保持不变", "2026-09-22", "2026-09-30", "In Progress");
  const desired = toDesiredEvent(readProjectItem(keep), "nbtca", 5);
  const fresh = issueNode("PVTI_new", "新日程", "2026-09-30", "2026-10-10", "Todo");
  const renamed = issueNode("PVTI_edit", "改过的标题", "2026-09-25", "2026-09-30", "Todo");
  const previous = toDesiredEvent(
    { ...readProjectItem(renamed), title: "旧标题" },
    "nbtca",
    5,
  );

  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method ?? "GET", body: options.body });
    if (href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token" });
    }
    if (href === "https://api.github.com/graphql") {
      const variables = JSON.parse(options.body).variables;
      if (!variables.cursor) {
        return Response.json({
          data: {
            organization: {
              projectV2: {
                items: {
                  pageInfo: { hasNextPage: true, endCursor: "page-2" },
                  nodes: [keep, renamed],
                },
              },
            },
          },
        });
      }
      return Response.json({
        data: {
          organization: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [fresh, issueNode("PVTI_blank", "无日期", null, null)],
              },
            },
          },
        },
      });
    }
    if (href.startsWith("https://www.googleapis.com/calendar/v3/calendars/") && (options.method ?? "GET") === "GET") {
      const page = new URL(href).searchParams.get("pageToken");
      if (!page) {
        return Response.json({
          items: [
            markedEvent(
              "event-keep",
              "PVTI_keep",
              desired.summary,
              desired.startDate,
              desired.endDateExclusive,
              desired.description,
            ),
          ],
          nextPageToken: "events-2",
        });
      }
      return Response.json({
        items: [
          markedEvent(
            "event-edit",
            "PVTI_edit",
            previous.summary,
            previous.startDate,
            previous.endDateExclusive,
            previous.description,
          ),
          markedEvent("event-stale", "PVTI_gone", "已移除", "2026-01-01", "2026-01-02", "old"),
          { id: "manual", summary: "手工日程" },
        ],
      });
    }
    return Response.json({});
  };

  const result = await syncProjectCalendar(env, { fetchImpl });
  assert.deepEqual(result, {
    considered: 3,
    created: 1,
    updated: 1,
    deleted: 1,
    unchanged: 1,
    invalid: 0,
  });

  const writes = calls.filter((call) => ["POST", "PATCH", "DELETE"].includes(call.method) && call.href.includes("/events"));
  assert.equal(writes.length, 3);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[1].method, "PATCH");
  assert.equal(writes[2].method, "DELETE");
  assert.match(writes[0].href, /sendUpdates=none/);
  const created = JSON.parse(writes[0].body);
  assert.equal(created.summary, "新日程");
  assert.equal(created.start.date, "2026-09-30");
  assert.equal(created.end.date, "2026-10-11");
  assert.equal(created.transparency, "transparent");
  assert.equal(created.extendedProperties.private.githubItemId, "PVTI_new");
  assert.equal(created.extendedProperties.private.githubProject, "nbtca/projects/5");
  assert.match(writes[1].href, /\/events\/event-edit/);
  assert.match(writes[2].href, /\/events\/event-stale/);
  assert.equal(calls.some((call) => call.href.includes("manual")), false);
});

test("stops when Google refuses a write", async () => {
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token" });
    }
    if (href === "https://api.github.com/graphql") {
      return Response.json({
        data: {
          organization: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [issueNode("PVTI_new", "新日程", "2026-09-30", "2026-10-10")],
              },
            },
          },
        },
      });
    }
    if ((options.method ?? "GET") === "GET") return Response.json({ items: [] });
    return Response.json({ error: { message: "Rate Limit Exceeded" } }, { status: 429 });
  };

  await assert.rejects(
    () => syncProjectCalendar(env, { fetchImpl }),
    /Google Calendar 429: Rate Limit Exceeded/,
  );
});
