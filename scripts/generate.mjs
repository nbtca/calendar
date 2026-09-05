import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { generateCalendar, validateEvents } from "./lib/ics.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataDirectory = path.join(root, "data", "school");
const outputDirectory = path.join(root, "dist");
const outputPath = path.join(outputDirectory, "school.ics");

const filenames = (await readdir(dataDirectory))
  .filter((name) => name.endsWith(".yaml"))
  .sort();

const events = [];
for (const filename of filenames) {
  const document = YAML.parse(await readFile(path.join(dataDirectory, filename), "utf8"));
  if (document?.schema !== 1 || !Array.isArray(document.events)) {
    throw new Error(`${filename} must contain schema: 1 and an events array`);
  }
  events.push(...document.events);
}

validateEvents(events);
const generated = generateCalendar(events);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(path.join(root, "assets"), outputDirectory, { recursive: true });
await writeFile(outputPath, generated);
console.log(`Generated ${events.length} school events in dist/school.ics`);
