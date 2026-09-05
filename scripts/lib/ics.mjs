const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function escapeText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

export function unescapeText(value) {
  return String(value)
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function foldLine(line) {
  const chunks = [];
  let chunk = "";
  let limit = 75;

  for (const character of line) {
    const candidate = chunk + character;
    if (Buffer.byteLength(candidate, "utf8") > limit && chunk) {
      const trailingWhitespace = chunk.match(/\s+$/)?.[0] || "";
      if (trailingWhitespace) {
        chunk = chunk.slice(0, -trailingWhitespace.length);
      }
      chunks.push(chunk);
      chunk = trailingWhitespace + character;
      limit = 74;
    } else {
      chunk = candidate;
    }
  }

  chunks.push(chunk);
  return chunks.join("\r\n ");
}

function compactDate(date) {
  return date.replaceAll("-", "");
}

function compactTimestamp(value) {
  if (/^\d{8}T\d{6}Z$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function property(name, value) {
  return foldLine(`${name}:${value}`);
}

export function validateEvents(events) {
  const ids = new Set();
  const uids = new Set();

  for (const [index, event] of events.entries()) {
    const label = event.id || `event ${index + 1}`;
    if (!event.id || typeof event.id !== "string") {
      throw new Error(`Event ${index + 1} is missing id`);
    }
    if (ids.has(event.id)) throw new Error(`Duplicate event id: ${event.id}`);
    ids.add(event.id);

    if (!event.uid || typeof event.uid !== "string") {
      throw new Error(`${label} is missing uid`);
    }
    if (uids.has(event.uid)) throw new Error(`Duplicate event uid: ${event.uid}`);
    uids.add(event.uid);

    if (!event.title?.trim()) throw new Error(`${label} is missing title`);
    if (event.title.startsWith("[NBT]")) {
      throw new Error(`${label} title must not include the legacy [NBT] prefix`);
    }
    if (!DATE_PATTERN.test(event.startDate)) {
      throw new Error(`${label} has invalid startDate`);
    }
    if (!DATE_PATTERN.test(event.endDateExclusive)) {
      throw new Error(`${label} has invalid endDateExclusive`);
    }
    if (event.endDateExclusive <= event.startDate) {
      throw new Error(`${label} must end after it starts`);
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 0) {
      throw new Error(`${label} has invalid sequence`);
    }
    compactTimestamp(event.updatedAt);
  }

  return events;
}

export function generateCalendar(events) {
  validateEvents(events);
  const sorted = [...events].sort((left, right) =>
    left.startDate.localeCompare(right.startDate) || left.uid.localeCompare(right.uid),
  );

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NBTCA//School Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    property("X-WR-CALNAME", escapeText("浙大宁波理工学院校历")),
    "X-WR-TIMEZONE:Asia/Shanghai",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const event of sorted) {
    lines.push(
      "BEGIN:VEVENT",
      property("UID", event.uid),
      property("DTSTAMP", compactTimestamp(event.updatedAt)),
      property("LAST-MODIFIED", compactTimestamp(event.updatedAt)),
      property("SEQUENCE", event.sequence),
      property("DTSTART;VALUE=DATE", compactDate(event.startDate)),
      property("DTEND;VALUE=DATE", compactDate(event.endDateExclusive)),
      property("SUMMARY", escapeText(event.title)),
    );
    if (event.description) {
      lines.push(property("DESCRIPTION", escapeText(event.description)));
    }
    if (event.location) {
      lines.push(property("LOCATION", escapeText(event.location)));
    }
    lines.push(
      "TRANSP:TRANSPARENT",
      "STATUS:CONFIRMED",
      "CATEGORIES:SCHOOL",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}

export function parseGoogleCalendar(source) {
  const unfolded = source.replace(/\r?\n[ \t]/g, "");
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g)];

  return blocks.map(([, block]) => {
    const values = new Map();
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/);
      if (match && !values.has(match[1])) values.set(match[1], match[2]);
    }

    const dateValue = (key) => {
      const value = values.get(key);
      return value && /^\d{8}$/.test(value)
        ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
        : null;
    };

    return {
      uid: values.get("UID"),
      title: unescapeText(values.get("SUMMARY") || ""),
      description: unescapeText(values.get("DESCRIPTION") || ""),
      location: unescapeText(values.get("LOCATION") || ""),
      startDate: dateValue("DTSTART"),
      endDateExclusive: dateValue("DTEND"),
      sequence: Number.parseInt(values.get("SEQUENCE") || "0", 10),
      updatedAt:
        values.get("LAST-MODIFIED") || values.get("DTSTAMP") || "20260905T000000Z",
    };
  });
}
