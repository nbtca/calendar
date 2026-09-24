import {
  diffCalendar,
  googleEventBody,
  projectMarker,
  readProjectItem,
  toDesiredEvent,
} from "./plan.js";

const REQUIRED = [
  "GITHUB_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_ID",
];

const ITEMS_QUERY = `
  query($login: String!, $number: Int!, $cursor: String) {
    organization(login: $login) {
      projectV2(number: $number) {
        items(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content {
              __typename
              ... on Issue {
                title
                url
                number
                repository { nameWithOwner }
              }
              ... on DraftIssue { title }
              ... on PullRequest {
                title
                url
                number
                repository { nameWithOwner }
              }
            }
            fieldValues(first: 40) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function missingEnv(env) {
  return REQUIRED.filter((name) => !env?.[name]);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 200) } };
  }
}

async function refreshAccessToken(fetchImpl, env) {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const payload = await readJson(response);
  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description || payload.error || response.status;
    throw new Error(`Google token refresh failed: ${reason}`);
  }
  return payload.access_token;
}

async function googlePayload(response) {
  const payload = await readJson(response);
  if (response.ok) return payload;
  const message = payload.error?.message || response.status;
  const error = new Error(`Google Calendar ${response.status}: ${message}`);
  error.status = response.status;
  throw error;
}

async function listDatedItems(fetchImpl, env, owner, number) {
  const items = [];
  let cursor = null;
  do {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "nbtca-project-calendar",
      },
      body: JSON.stringify({
        query: ITEMS_QUERY,
        variables: { login: owner, number, cursor },
      }),
    });
    const payload = await readJson(response);
    if (!response.ok || payload.errors) {
      const message =
        payload.errors?.map((error) => error.message).join("; ") ||
        payload.message ||
        response.status;
      throw new Error(`GitHub project query failed: ${message}`);
    }
    const project = payload.data?.organization?.projectV2;
    if (!project) throw new Error(`GitHub project ${owner}/${number} was not found`);
    for (const node of project.items.nodes) {
      const item = readProjectItem(node);
      if (item) items.push(item);
    }
    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

async function listEvents(fetchImpl, accessToken, calendarId) {
  const events = [];
  let pageToken = null;
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = await googlePayload(response);
    events.push(...(payload.items ?? []));
    pageToken = payload.nextPageToken ?? null;
  } while (pageToken);
  return events;
}

async function writeEvent(fetchImpl, accessToken, calendarId, method, body, eventId) {
  const path = eventId
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const url = new URL(path);
  url.searchParams.set("sendUpdates", "none");
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  await googlePayload(response);
}

export async function syncProjectCalendar(env, options = {}) {
  const missing = missingEnv(env);
  if (missing.length > 0) {
    throw new Error(`Missing sync configuration: ${missing.join(", ")}`);
  }
  const owner = env.GITHUB_PROJECT_OWNER || "nbtca";
  const number = Number(env.GITHUB_PROJECT_NUMBER || 5);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("GITHUB_PROJECT_NUMBER must be a positive integer");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const marker = projectMarker(owner, number);
  const accessToken = await refreshAccessToken(fetchImpl, env);
  const items = await listDatedItems(fetchImpl, env, owner, number);
  const desired = items.map((item) => toDesiredEvent(item, owner, number)).filter(Boolean);
  const existing = await listEvents(fetchImpl, accessToken, env.GOOGLE_CALENDAR_ID);
  const plan = diffCalendar(desired, existing, marker);

  for (const desiredEvent of plan.create) {
    await writeEvent(
      fetchImpl,
      accessToken,
      env.GOOGLE_CALENDAR_ID,
      "POST",
      googleEventBody(desiredEvent, marker),
    );
  }
  for (const change of plan.update) {
    await writeEvent(
      fetchImpl,
      accessToken,
      env.GOOGLE_CALENDAR_ID,
      "PATCH",
      googleEventBody(change.desired, marker),
      change.eventId,
    );
  }
  for (const stale of plan.remove) {
    await writeEvent(
      fetchImpl,
      accessToken,
      env.GOOGLE_CALENDAR_ID,
      "DELETE",
      null,
      stale.eventId,
    );
  }

  if (plan.invalid.length > 0) {
    const details = plan.invalid.map((item) => `${item.itemId}: ${item.error}`).join("; ");
    throw new Error(`Invalid project dates: ${details}`);
  }

  return {
    considered: items.length,
    created: plan.create.length,
    updated: plan.update.length,
    deleted: plan.remove.length,
    unchanged: plan.unchanged.length,
    invalid: plan.invalid.length,
  };
}
