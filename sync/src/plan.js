const START_FIELD = "Start date";
const END_FIELD = "End date";
const STATUS_FIELD = "Status";

export function projectMarker(owner, number) {
  return `${owner}/projects/${number}`;
}

export function projectUrl(owner, number) {
  return `https://github.com/orgs/${owner}/projects/${number}`;
}

export function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function readProjectItem(node) {
  const values = node.fieldValues?.nodes ?? [];
  const dated = (name) =>
    values.find(
      (value) =>
        value?.__typename === "ProjectV2ItemFieldDateValue" && value.field?.name === name,
    )?.date || null;
  const start = dated(START_FIELD);
  const end = dated(END_FIELD);
  if (!start && !end) return null;

  const content = node.content ?? {};
  const status =
    values.find(
      (value) =>
        value?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
        value.field?.name === STATUS_FIELD,
    )?.name || null;
  return {
    itemId: node.id,
    title: content.title || "(untitled)",
    url: content.url || null,
    number: content.number ?? null,
    repository: content.repository?.nameWithOwner || null,
    status,
    start,
    end,
    updatedAt: node.updatedAt || null,
  };
}

function inclusiveRange(start, end) {
  const startDate = start || end;
  const inclusiveEnd = end || start;
  if (!startDate || !inclusiveEnd) return null;
  if (inclusiveEnd < startDate) {
    return { error: `end ${inclusiveEnd} is before start ${startDate}` };
  }
  return { startDate, endDateExclusive: addDays(inclusiveEnd, 1) };
}

export function toDesiredEvent(item, owner, number) {
  const range = inclusiveRange(item.start, item.end);
  if (!range) return null;
  if (range.error) return { itemId: item.itemId, error: range.error };

  const description = [
    item.url,
    item.repository && item.number != null ? `${item.repository}#${item.number}` : null,
    item.status ? `Status: ${item.status}` : null,
    `Project: ${projectUrl(owner, number)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    itemId: item.itemId,
    summary: item.title,
    description,
    startDate: range.startDate,
    endDateExclusive: range.endDateExclusive,
    sourceUrl: item.url,
  };
}

export function projectCalendarEvents(items, owner, number) {
  const events = [];
  for (const item of items) {
    const desired = toDesiredEvent(item, owner, number);
    if (!desired || desired.error || !item.updatedAt) continue;
    events.push({
      id: item.itemId,
      uid: `${item.itemId}@project.nbtca.space`,
      title: desired.summary,
      description: desired.description,
      startDate: desired.startDate,
      endDateExclusive: desired.endDateExclusive,
      sequence: 0,
      updatedAt: item.updatedAt,
    });
  }
  return events;
}

export function googleEventBody(desired, marker) {
  const body = {
    summary: desired.summary,
    description: desired.description,
    start: { date: desired.startDate },
    end: { date: desired.endDateExclusive },
    transparency: "transparent",
    extendedProperties: {
      private: {
        githubItemId: desired.itemId,
        githubProject: marker,
      },
    },
  };
  if (desired.sourceUrl) body.source = { title: "GitHub", url: desired.sourceUrl };
  return body;
}

function sameEvent(event, desired) {
  return (
    event.summary === desired.summary &&
    (event.description ?? "") === desired.description &&
    event.start?.date === desired.startDate &&
    event.end?.date === desired.endDateExclusive &&
    event.transparency === "transparent"
  );
}

export function diffCalendar(desiredEvents, existingEvents, marker) {
  const ours = new Map();
  const remove = [];
  for (const event of existingEvents) {
    const props = event.extendedProperties?.private ?? {};
    if (props.githubProject !== marker || !props.githubItemId || !event.id) continue;
    if (ours.has(props.githubItemId)) {
      remove.push({ itemId: props.githubItemId, eventId: event.id });
      continue;
    }
    ours.set(props.githubItemId, event);
  }

  const create = [];
  const update = [];
  const unchanged = [];
  const invalid = [];
  for (const desired of desiredEvents) {
    if (desired.error) {
      invalid.push(desired);
      ours.delete(desired.itemId);
      continue;
    }
    const current = ours.get(desired.itemId);
    if (!current) {
      create.push(desired);
      continue;
    }
    ours.delete(desired.itemId);
    if (sameEvent(current, desired)) unchanged.push(desired);
    else update.push({ desired, eventId: current.id });
  }

  for (const event of ours.values()) {
    remove.push({
      itemId: event.extendedProperties.private.githubItemId,
      eventId: event.id,
    });
  }
  return { create, update, remove, unchanged, invalid };
}
