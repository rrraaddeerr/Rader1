/**
 * Reminder helpers — pure functions (no I/O) so they unit-test with plain node.
 *
 * A reminder is stored in KV as `rem:<due14>-<rand>` where <due14> is the due
 * time in ms zero-padded to 14 digits. A plain key-prefix list therefore comes
 * back soonest-first, so the cron can read from the front and stop at the
 * first key whose due time is still in the future.
 */

const DUE_PAD = 14;

/** Build a reminder id (the part after the `rem:` prefix). */
export function reminderId(dueMs, rand) {
  const ts = Math.max(0, Math.floor(dueMs || 0));
  return `${String(ts).padStart(DUE_PAD, "0")}-${rand || crypto.randomUUID().slice(0, 8)}`;
}

/** Extract the due time (ms) back out of a reminder id or `rem:` key. */
export function dueFromReminderId(idOrKey) {
  const m = /^(?:rem:)?(\d{14})-/.exec(idOrKey || "");
  return m ? parseInt(m[1], 10) : null;
}

/** Accept a due time as ms-since-epoch or an ISO string; return ms or null. */
export function parseDue(due) {
  if (typeof due === "number" && Number.isFinite(due)) return Math.floor(due);
  if (typeof due === "string") {
    const asNum = Number(due);
    if (due.trim() && Number.isFinite(asNum)) return Math.floor(asNum);
    const ms = Date.parse(due);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export const REMINDER_CHANNELS = ["push", "sms", "whatsapp"];

/** The text sent over SMS / WhatsApp / shown in a notification body. */
export function reminderMessage(rem) {
  let msg = `🧠 Reminder: ${rem.title || "Untitled"}`;
  if (rem.note) msg += `\n${rem.note}`;
  if (rem.url) msg += `\n${rem.url}`;
  return msg;
}

// ---- ICS (Apple Reminders / Calendar import) ----

export function icsEscape(s = "") {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A minimal VCALENDAR/VEVENT with an at-time display alarm. Opening the file
 * on iPhone/Mac adds it to Apple Calendar (and macOS offers Reminders for
 * to-do imports) with an alert at the due time.
 */
export function buildIcs({ id = "bb", title = "Reminder", due, url = "", note = "", now = Date.now() }) {
  const dueMs = parseDue(due) ?? now;
  const desc = [note, url].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Big Brain//save-ref//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(id)}@bigbrain`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(dueMs)}`,
    `DTEND:${icsDate(dueMs + 30 * 60 * 1000)}`,
    `SUMMARY:🧠 ${icsEscape(title)}`,
  ];
  if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
  if (url) lines.push(`URL:${icsEscape(url)}`);
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(title)}`,
    "TRIGGER:-PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );
  return lines.join("\r\n");
}
