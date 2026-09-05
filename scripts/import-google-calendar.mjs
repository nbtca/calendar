import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import { parseGoogleCalendar } from "./lib/ics.mjs";

const DEFAULT_SOURCE = "https://ical.nbtca.space/";
const sourceUrl = process.env.ICAL_SOURCE_URL || DEFAULT_SOURCE;
const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Calendar download failed: ${response.status}`);

const source = await response.text();
const events = parseGoogleCalendar(source)
  .filter((event) => event.title.startsWith("[NBT]"))
  .map((event) => {
    if (!event.startDate || !event.endDateExclusive) {
      throw new Error(`School event ${event.uid} is not an all-day event`);
    }
    const suffix = createHash("sha256").update(event.uid).digest("hex").slice(0, 10);
    return {
      id: `imported-${event.startDate}-${suffix}`,
      uid: event.uid,
      title: event.title.replace(/^\[NBT\]\s*/, ""),
      startDate: event.startDate,
      endDateExclusive: event.endDateExclusive,
      description: event.description.trim() || undefined,
      location: event.location.trim() || undefined,
      sequence: event.sequence,
      updatedAt: event.updatedAt,
    };
  })
  .sort((left, right) => left.startDate.localeCompare(right.startDate));

function academicYear(startDate) {
  const year = Number(startDate.slice(0, 4));
  const month = Number(startDate.slice(5, 7));
  const first = month >= 8 ? year : year - 1;
  return `${first}-${first + 1}`;
}

const grouped = Map.groupBy(events, (event) => academicYear(event.startDate));
const outputDirectory = path.resolve(import.meta.dirname, "..", "data", "school");
await mkdir(outputDirectory, { recursive: true });

for (const [year, yearEvents] of grouped) {
  const contents = YAML.stringify({
    schema: 1,
    academicYear: year,
    importedFrom: sourceUrl,
    events: yearEvents,
  });
  await writeFile(path.join(outputDirectory, `${year}.yaml`), contents);
}

console.log(`Imported ${events.length} school events into ${grouped.size} files`);
