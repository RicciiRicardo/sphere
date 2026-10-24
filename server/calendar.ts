import { createDAVClient } from "tsdav";
import ical from "node-ical";
import { isMock } from "./providers.js";

// Ricardo keeps his meetings in iCloud Calendar. Sphere reads it over CalDAV
// with his Apple ID and an app-specific password (appleid.apple.com), read-only.
const env = (k: string) => process.env[k]?.trim() ?? "";

export function calendarConfigured() {
  return isMock() || Boolean(env("ICLOUD_USER") && env("ICLOUD_APP_PASSWORD"));
}

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  calendar: string;
}

let cache: { at: number; events: CalendarEvent[] } | undefined;

// Events from the start of today through the next `days` days, soonest first.
// Cached for five minutes; iCloud's CalDAV server is slow.
export async function upcomingEvents(days = 7): Promise<CalendarEvent[]> {
  if (isMock()) return mockEvents();
  if (!calendarConfigured()) return [];
  if (cache && Date.now() - cache.at < 300_000) return cache.events;

  const client = await createDAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username: env("ICLOUD_USER"), password: env("ICLOUD_APP_PASSWORD") },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 86_400_000);
  const calendars = (await client.fetchCalendars()).filter((c) => !c.components || c.components.includes("VEVENT"));

  const events: CalendarEvent[] = [];
  for (const cal of calendars) {
    const name = typeof cal.displayName === "string" ? cal.displayName : "Calendar";
    // expand: the server turns recurring events into one instance per date.
    const objects = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: start.toISOString(), end: end.toISOString() },
      expand: true,
    });
    for (const obj of objects) {
      if (!obj.data) continue;
      for (const item of Object.values(ical.sync.parseICS(obj.data))) {
        if (!item || item.type !== "VEVENT" || !item.start) continue;
        const s = new Date(item.start);
        const e = item.end ? new Date(item.end) : s;
        if (e < start || s > end) continue;
        events.push({
          title: String(item.summary ?? "(untitled)"),
          start: s.toISOString(),
          end: e.toISOString(),
          allDay: item.datetype === "date",
          location: String(item.location ?? ""),
          calendar: name,
        });
      }
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  cache = { at: Date.now(), events };
  return events;
}

export function formatEvents(events: CalendarEvent[], tz: string): string {
  if (!events.length) return "(Nothing on the calendar for the next week.)";
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" });
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return events
    .map(
      (e) =>
        `- ${day(e.start)}, ${e.allDay ? "all day" : `${time(e.start)} to ${time(e.end)}`}: ${e.title}${e.location ? ` (${e.location})` : ""}`,
    )
    .join("\n");
}

function mockEvents(): CalendarEvent[] {
  const at = (dayOffset: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { title: "Go Global team stand-up", start: at(0, 9), end: at(0, 10), allDay: false, location: "Zoom", calendar: "Work" },
    { title: "Call with Vanessa: Jamaica distribution", start: at(0, 14), end: at(0, 15), allDay: false, location: "", calendar: "Work" },
    { title: "Investor call with Aubyn", start: at(1, 10), end: at(1, 11), allDay: false, location: "Phone", calendar: "Work" },
  ];
}
