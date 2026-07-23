// Pure-logic tests for reminders.js — run with `node test/reminders.test.mjs`.
import {
  reminderId,
  dueFromReminderId,
  parseDue,
  buildIcs,
  icsEscape,
  reminderMessage,
} from "../src/reminders.js";

let pass = 0, fail = 0;
function ok(label, cond) { cond ? pass++ : (fail++, console.error("✗ " + label)); }
function eq(label, got, want) { ok(label + ` (got ${JSON.stringify(got)})`, got === want); }

// ids sort soonest-first and round-trip their due time
const t1 = Date.UTC(2026, 6, 23, 10, 0, 0);
const t2 = Date.UTC(2026, 6, 23, 11, 0, 0);
const id1 = reminderId(t1, "aaaa");
const id2 = reminderId(t2, "aaaa");
ok("earlier due sorts first", id1 < id2);
eq("due round-trips from id", dueFromReminderId(id1), t1);
eq("due round-trips from rem: key", dueFromReminderId("rem:" + id1), t1);
eq("garbage id -> null", dueFromReminderId("not-a-key"), null);

// parseDue accepts ms, numeric strings, and ISO
eq("parseDue ms", parseDue(t1), t1);
eq("parseDue numeric string", parseDue(String(t1)), t1);
eq("parseDue ISO", parseDue("2026-07-23T10:00:00.000Z"), t1);
eq("parseDue garbage -> null", parseDue("whenever"), null);
eq("parseDue undefined -> null", parseDue(undefined), null);

// ICS escaping
eq("escapes commas", icsEscape("a,b"), "a\\,b");
eq("escapes semicolons", icsEscape("a;b"), "a\\;b");
eq("escapes newlines", icsEscape("a\nb"), "a\\nb");
eq("escapes backslash", icsEscape("a\\b"), "a\\\\b");

// ICS structure
const ics = buildIcs({ id: "x1", title: "Return the jacket, please", due: t1, url: "https://x.io/a", now: t1 - 1000 });
ok("has VCALENDAR", ics.includes("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR"));
ok("has VEVENT", ics.includes("BEGIN:VEVENT"));
ok("has alarm", ics.includes("BEGIN:VALARM") && ics.includes("TRIGGER:-PT0M"));
ok("DTSTART is the due time", ics.includes("DTSTART:20260723T100000Z"));
ok("summary escaped", ics.includes("SUMMARY:🧠 Return the jacket\\, please"));
ok("url included", ics.includes("URL:https://x.io/a"));
ok("CRLF line endings", ics.includes("\r\n"));

// message body
eq(
  "message includes title + url",
  reminderMessage({ title: "Call mom", url: "https://x.io" }),
  "🧠 Reminder: Call mom\nhttps://x.io"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
