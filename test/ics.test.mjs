import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import { escapeText, foldLine, generateCalendar, validateEvents } from "../scripts/lib/ics.mjs";

const example = {
  id: "fall-classes-start-2026",
  uid: "school/fall-classes-start-2026@nbtca.space",
  title: "秋季学期开始上课",
  startDate: "2026-09-14",
  endDateExclusive: "2026-09-15",
  description: "第一周\n来源：学校校历",
  sequence: 0,
  updatedAt: "2026-09-05T00:00:00Z",
};

test("escapes calendar text", () => {
  assert.equal(escapeText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
});

test("folds UTF-8 lines to at most 75 octets", () => {
  const folded = foldLine(`SUMMARY:${"学校日历".repeat(20)}`);
  const lines = folded.split("\r\n");
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 75);
});

test("generates a standards-parseable all-day calendar", () => {
  const generated = generateCalendar([example]);
  const component = new ICAL.Component(ICAL.parse(generated));
  const event = new ICAL.Event(component.getFirstSubcomponent("vevent"));
  assert.equal(event.uid, example.uid);
  assert.equal(event.summary, example.title);
  assert.equal(event.startDate.toString(), "2026-09-14");
  assert.equal(event.endDate.toString(), "2026-09-15");
  assert.match(generated, /TRANSP:TRANSPARENT/);
});

test("rejects duplicate stable identifiers", () => {
  assert.throws(() => validateEvents([example, { ...example }]), /Duplicate event id/);
});
