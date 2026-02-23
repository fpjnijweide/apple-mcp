import { runAppleScript } from 'run-applescript';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Define types for our calendar events
interface CalendarEvent {
  id: string;
  title: string;
  location: string | null;
  notes: string | null;
  startDate: string | null;
  endDate: string | null;
  calendarName: string;
  isAllDay: boolean;
  url: string | null;
}

// Configuration for timeouts and limits
const CONFIG = {
  TIMEOUT_MS: 10000,
  MAX_EVENTS: 20
};

// cal-helper: EventKit-based CLI tool (replaces icalBuddy which uses legacy CalendarStore)
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CAL_HELPER_APP = join(__dirname, '..', 'CalHelper.app');
const CAL_HELPER_BIN = join(CAL_HELPER_APP, 'Contents', 'MacOS', 'cal-helper');

/**
 * Format a Date as YYYY-MM-DD for icalBuddy
 */
function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parse icalBuddy output into CalendarEvent objects.
 *
 * We use a custom separator format:
 *   -b "<<<EVENT>>>" for bullet point (event start)
 *   -ps "|<<<F>>>|" for property separator
 *   -po "title,datetime,location,notes,url,calendarName" for property order
 *   -iep same list to include only these properties
 *
 * Each event line looks like:
 *   <<<EVENT>>>title<<<F>>>datetime<<<F>>>location: ...<<<F>>>notes: ...<<<F>>>url: ...<<<F>>>calendarName (calendar)
 *
 * Multi-line notes are joined back together.
 */
function parseIcalBuddyOutput(output: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  if (!output || output.trim() === '') return events;

  // Output uses -sc (separate by calendar). Sections look like:
  //   CalendarName:<<<CAL>>>
  //   <<<EVENT>>>title<<<F>>>datetime<<<F>>>...
  //   <<<EVENT>>>title<<<F>>>datetime<<<F>>>...
  //
  // We track the current calendar by looking for "Name:<<<CAL>>>" headers.
  let currentCalendar = 'Unknown';

  // Remove <<<CAL>>> markers and use them to identify calendar headers
  const lines = output.split('\n');
  const cleanedParts: string[] = [];
  const calendarMap = new Map<number, string>(); // line index -> calendar name

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const calMatch = line.match(/^(.+):<<<CAL>>>$/);
    if (calMatch) {
      // This is a calendar section header
      calendarMap.set(cleanedParts.length, calMatch[1].trim());
    } else {
      cleanedParts.push(line);
    }
  }

  const cleanedOutput = cleanedParts.join('\n');
  const rawEvents = cleanedOutput.split('<<<EVENT>>>').filter(s => s.trim() !== '');

  // Track which event index corresponds to which calendar
  // Count events and match with calendar headers by position
  let eventIdx = 0;
  let linePos = 0;

  // Simpler approach: re-parse with calendar tracking
  // Reset and walk through lines sequentially
  currentCalendar = 'Unknown';
  const eventTexts: { text: string; calendarName: string }[] = [];
  let currentEventText = '';

  for (const line of lines) {
    const calMatch = line.match(/^(.+):<<<CAL>>>$/);
    if (calMatch) {
      // Flush any current event
      if (currentEventText.trim()) {
        eventTexts.push({ text: currentEventText, calendarName: currentCalendar });
        currentEventText = '';
      }
      currentCalendar = calMatch[1].trim();
      continue;
    }

    // Check if this line starts a new event
    if (line.includes('<<<EVENT>>>')) {
      // Flush previous event
      if (currentEventText.trim()) {
        eventTexts.push({ text: currentEventText, calendarName: currentCalendar });
      }
      currentEventText = line.replace('<<<EVENT>>>', '');
    } else {
      // Continuation of current event (multi-line notes)
      currentEventText += '\n' + line;
    }
  }
  // Flush last event
  if (currentEventText.trim()) {
    eventTexts.push({ text: currentEventText, calendarName: currentCalendar });
  }

  for (const { text: raw, calendarName } of eventTexts) {
      const parts = raw.split('<<<F>>>');

      const title = (parts[0] || '').trim();

      // Parse remaining fields by their prefixes
      let datetimeStr = '';
      let location: string | null = null;
      let notes: string | null = null;
      let url: string | null = null;
      let uid: string | null = null;

      for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        if (part.startsWith('location: ')) {
          location = part.slice('location: '.length).trim() || null;
        } else if (part.startsWith('notes: ')) {
          notes = part.slice('notes: '.length).trim() || null;
        } else if (part.startsWith('url: ')) {
          url = part.slice('url: '.length).trim() || null;
        } else if (part.startsWith('uid: ')) {
          uid = part.slice('uid: '.length).trim() || null;
        } else if (part !== '') {
          if (!datetimeStr) {
            datetimeStr = part;
          }
        }
      }

      // Parse datetime - icalBuddy outputs like:
      //   "2026-02-22 at 20:00:00 - 23:00:00"  (same day)
      //   "2026-02-22 at 20:00:00 - 2026-02-23 at 01:00:00"  (cross day)
      //   "2026-02-23"  (all-day event)
      //   "20:00:00 - 23:00:00"  (today, no date shown)
      let startDate: string | null = null;
      let endDate: string | null = null;
      let isAllDay = false;

      if (datetimeStr) {
        const dashParts = datetimeStr.split(' - ');
        const startPart = dashParts[0] || '';
        const endPart = dashParts[1] || '';

        if (startPart.includes(' at ')) {
          const [datePart, timePart] = startPart.split(' at ');
          startDate = `${datePart.trim()}T${timePart.trim()}`;

          if (endPart.includes(' at ')) {
            const [endDatePart, endTimePart] = endPart.split(' at ');
            endDate = `${endDatePart.trim()}T${endTimePart.trim()}`;
          } else if (endPart) {
            endDate = `${datePart.trim()}T${endPart.trim()}`;
          }
        } else if (/^\d{2}:\d{2}:\d{2}$/.test(startPart.trim())) {
          const todayStr = formatDateLocal(new Date());
          startDate = `${todayStr}T${startPart.trim()}`;
          if (endPart) {
            endDate = `${todayStr}T${endPart.trim()}`;
          }
        } else {
          isAllDay = true;
          startDate = startPart.trim();
          endDate = endPart ? endPart.trim() : startPart.trim();
        }
      }

      if (title) {
        events.push({
          id: uid || `ical-${Buffer.from(title + datetimeStr).toString('base64').slice(0, 20)}`,
          title,
          location,
          notes,
          startDate,
          endDate,
          calendarName,
          isAllDay,
          url,
        });
      }
  }

  return events;
}

/**
 * Get the list of calendar names that the user has disabled in Calendar.app.
 * Reads DisabledCalendars from com.apple.iCal preferences, then maps UIDs
 * to calendar names via icalBuddy.
 */
async function getDisabledCalendarNames(): Promise<string[]> {
  try {
    // Read disabled calendar UIDs from Calendar.app prefs
    const { stdout: prefsOut } = await execAsync(
      'defaults read com.apple.iCal DisabledCalendars 2>/dev/null',
      { timeout: 3000 }
    );
    const uidMatches = prefsOut.match(
      /"([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})"/gi
    );
    if (!uidMatches || uidMatches.length === 0) return [];
    const disabledUids = new Set(uidMatches.map(m => m.replace(/"/g, '')));

    // Get calendar name -> UID mapping from cal-helper
    const { stdout: calOut } = await execAsync(
      `"${CAL_HELPER_BIN}" calendars`,
      { timeout: 5000 }
    );
    const disabled: string[] = [];
    let currentName = '';
    for (const line of calOut.split('\n')) {
      const nameMatch = line.match(/^[•*]\s+(.+)$/);
      if (nameMatch) {
        currentName = nameMatch[1].trim();
      }
      const uidMatch = line.match(/^\s+UID:\s+(.+)$/);
      if (uidMatch && currentName && disabledUids.has(uidMatch[1].trim())) {
        disabled.push(currentName);
      }
    }
    return disabled;
  } catch {
    return []; // If anything fails, don't filter
  }
}

/**
 * Run cal-helper via the .app bundle. Tries direct execution first (works from
 * Terminal), then falls back to `open -W` with a temp file (needed for Claude
 * Desktop where the parent process lacks Calendar TCC).
 */
async function runCalHelper(
  fromDate: string,
  toDate: string,
  limit: number
): Promise<CalendarEvent[]> {
  const maxEvents = Math.min(limit, CONFIG.MAX_EVENTS);

  const disabled = await getDisabledCalendarNames();
  const excludeArg = disabled.length > 0 ? `"${disabled.join(',')}"` : '';

  const baseArgs = ['events', fromDate, toDate, String(maxEvents), excludeArg].filter(Boolean);

  // Try direct execution first (fast, works from Terminal)
  try {
    const directCmd = [`"${CAL_HELPER_BIN}"`, ...baseArgs].join(' ');
    const { stdout, stderr } = await execAsync(directCmd, { timeout: CONFIG.TIMEOUT_MS });
    if (stderr && stderr.includes('denied')) {
      throw new Error('access_denied');
    }
    return parseIcalBuddyOutput(stdout);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `cal-helper not found at ${CAL_HELPER_BIN}. Rebuild with: swiftc cal-helper.swift -o CalHelper.app/Contents/MacOS/cal-helper -framework EventKit`
      );
    }
    // If direct execution was denied, fall back to open -W
    const isDenied = error.message === 'access_denied' ||
      (error.stderr && error.stderr.includes('denied')) ||
      (error.message && error.message.includes('denied'));
    if (!isDenied) throw error;
  }

  // Fallback: launch as .app via `open -W` so it becomes its own responsible process
  const tmpFile = `/tmp/cal-helper-${Date.now()}.txt`;
  const openArgs = ['--output', tmpFile, ...baseArgs];
  const openCmd = `open -W -g "${CAL_HELPER_APP}" --args ${openArgs.join(' ')}`;

  try {
    await execAsync(openCmd, { timeout: CONFIG.TIMEOUT_MS });
    const { readFile, unlink } = await import('fs/promises');
    const output = await readFile(tmpFile, 'utf-8');
    await unlink(tmpFile).catch(() => {});
    return parseIcalBuddyOutput(output);
  } catch (error: any) {
    throw new Error(
      'Calendar access denied. Go to System Settings > Privacy & Security > Calendars and enable access for CalHelper.'
    );
  }
}

/**
 * Check if the Calendar app is accessible
 */
async function checkCalendarAccess(): Promise<boolean> {
  try {
    const today = formatDateLocal(new Date());
    await execAsync(`"${CAL_HELPER_BIN}" events ${today} ${today} 1`, { timeout: 5000 });
    return true;
  } catch (error) {
    console.error(
      `Cannot access Calendar: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Request Calendar app access and provide instructions if not available
 */
async function requestCalendarAccess(): Promise<{
  hasAccess: boolean;
  message: string;
}> {
  try {
    const hasAccess = await checkCalendarAccess();
    if (hasAccess) {
      return { hasAccess: true, message: 'Calendar access is already granted.' };
    }

    return {
      hasAccess: false,
      message:
        'Calendar access is required but not granted. Please:\n' +
        '1. Open System Settings > Privacy & Security > Calendars\n' +
        '2. Enable calendar access for the app running this MCP server (e.g. Claude, Terminal)\n' +
        '3. Restart the app and try again',
    };
  } catch (error) {
    return {
      hasAccess: false,
      message: `Error checking Calendar access: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get calendar events in a specified date range
 */
async function getEvents(
  limit = 10,
  fromDate?: string,
  toDate?: string
): Promise<CalendarEvent[]> {
  try {
    console.error('getEvents - Starting to fetch calendar events');

    const today = new Date();
    const defaultEndDate = new Date();
    defaultEndDate.setDate(today.getDate() + 7);

    const startDate = fromDate ? new Date(fromDate) : today;
    const endDate = toDate ? new Date(toDate) : defaultEndDate;

    return await runCalHelper(formatDateLocal(startDate), formatDateLocal(endDate), limit);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error getting events: ${msg}`);
    throw new Error(`Calendar error: ${msg}`);
  }
}

/**
 * Search for calendar events that match the search text
 */
async function searchEvents(
  searchText: string,
  limit = 10,
  fromDate?: string,
  toDate?: string
): Promise<CalendarEvent[]> {
  try {
    console.error(
      `searchEvents - Searching for: "${searchText}"`
    );

    const today = new Date();
    const defaultEndDate = new Date();
    defaultEndDate.setDate(today.getDate() + 30);

    const startDate = fromDate ? new Date(fromDate) : today;
    const endDate = toDate ? new Date(toDate) : defaultEndDate;

    // Fetch more events than limit since we filter client-side
    const allEvents = await runCalHelper(formatDateLocal(startDate), formatDateLocal(endDate), CONFIG.MAX_EVENTS);

    // Filter by search text (case-insensitive)
    const searchLower = searchText.toLowerCase();
    const filtered = allEvents.filter(event => {
      const fields = [event.title, event.location, event.notes, event.calendarName];
      return fields.some(
        f => f && f.toLowerCase().includes(searchLower)
      );
    });

    return filtered.slice(0, limit);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error searching events: ${msg}`);
    throw new Error(`Calendar search error: ${msg}`);
  }
}

/**
 * Create a new calendar event (uses AppleScript since icalBuddy is read-only)
 */
async function createEvent(
  title: string,
  startDate: string,
  endDate: string,
  location?: string,
  notes?: string,
  isAllDay = false,
  calendarName?: string
): Promise<{ success: boolean; message: string; eventId?: string }> {
  try {
    if (!title.trim()) {
      return { success: false, message: 'Event title cannot be empty' };
    }
    if (!startDate || !endDate) {
      return { success: false, message: 'Start date and end date are required' };
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return {
        success: false,
        message: 'Invalid date format. Please use ISO format (YYYY-MM-DDTHH:mm:ss)',
      };
    }
    if (end <= start) {
      return { success: false, message: 'End date must be after start date' };
    }

    console.error(`createEvent - Creating event: "${title}"`);

    const targetCalendar = calendarName || 'Calendar';

    const script = `
tell application "Calendar"
    set startDate to date "${start.toLocaleString()}"
    set endDate to date "${end.toLocaleString()}"

    set targetCal to null
    try
        set targetCal to calendar "${targetCalendar}"
    on error
        set targetCal to first calendar
    end try

    tell targetCal
        set newEvent to make new event with properties {summary:"${title.replace(/"/g, '\\"')}", start date:startDate, end date:endDate, allday event:${isAllDay}}

        if "${location || ''}" ≠ "" then
            set location of newEvent to "${(location || '').replace(/"/g, '\\"')}"
        end if

        if "${notes || ''}" ≠ "" then
            set description of newEvent to "${(notes || '').replace(/"/g, '\\"')}"
        end if

        return uid of newEvent
    end tell
end tell`;

    const eventId = (await runAppleScript(script)) as string;

    return {
      success: true,
      message: `Event "${title}" created successfully.`,
      eventId: eventId,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error creating event: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Open a specific calendar event in the Calendar app
 */
async function openEvent(
  eventId: string
): Promise<{ success: boolean; message: string }> {
  try {
    console.error(`openEvent - Opening event: ${eventId}`);

    const script = `
tell application "Calendar"
    activate
    return "Calendar app opened"
end tell`;

    const result = (await runAppleScript(script)) as string;
    return { success: true, message: result };
  } catch (error) {
    return {
      success: false,
      message: `Error opening event: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const calendar = {
  searchEvents,
  openEvent,
  getEvents,
  createEvent,
  requestCalendarAccess,
};

export default calendar;
