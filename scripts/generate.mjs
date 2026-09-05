import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import { generateCalendar, validateEvents } from "./lib/ics.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataDirectory = path.join(root, "data", "school");
const outputPath = path.join(root, "public", "school.ics");

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

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    throw new Error("public/school.ics is out of date; run pnpm build");
  }
} else {
  await writeFile(outputPath, generated);
  console.log(`Generated ${events.length} school events in public/school.ics`);
}
