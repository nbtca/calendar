import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ICAL from "ical.js";
import YAML from "yaml";

test("generated school feed represents every source event exactly once", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const directory = path.join(root, "data", "school");
  const filenames = (await readdir(directory)).filter((name) => name.endsWith(".yaml"));
  const sourceEvents = [];

  for (const filename of filenames) {
    const document = YAML.parse(await readFile(path.join(directory, filename), "utf8"));
    sourceEvents.push(...document.events);
  }

  const generated = await readFile(path.join(root, "public", "school.ics"), "utf8");
  const calendar = new ICAL.Component(ICAL.parse(generated));
  const generatedEvents = calendar.getAllSubcomponents("vevent").map((component) =>
    new ICAL.Event(component),
  );

  assert.equal(generatedEvents.length, sourceEvents.length);
  assert.equal(new Set(generatedEvents.map((event) => event.uid)).size, sourceEvents.length);
  assert.deepEqual(
    generatedEvents.map((event) => event.startDate.toString()).sort(),
    sourceEvents.map((event) => event.startDate).sort(),
  );
});
