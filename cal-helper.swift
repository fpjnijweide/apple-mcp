import EventKit
import Foundation

let store = EKEventStore()
let args = CommandLine.arguments

// Request access synchronously
let semaphore = DispatchSemaphore(value: 0)
var accessGranted = false

store.requestFullAccessToEvents { granted, error in
    accessGranted = granted
    if !granted {
        let msg = error?.localizedDescription ?? "unknown"
        FileHandle.standardError.write("Calendar access denied: \(msg)\n".data(using: .utf8)!)
    }
    semaphore.signal()
}
semaphore.wait()

guard accessGranted else { exit(1) }

// Separators matching the MCP parser
let EVENT_SEP = "<<<EVENT>>>"
let FIELD_SEP = "<<<F>>>"
let CAL_SEP = "<<<CAL>>>"

func formatDate(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    return f.string(from: date)
}

func formatDateOnly(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}

// Output destination: stdout by default, or file if --output is specified
var outputFile: String? = nil
var filteredArgs = [String]()
var i = 0
while i < args.count {
    if args[i] == "--output" && i + 1 < args.count {
        outputFile = args[i + 1]
        i += 2
    } else {
        filteredArgs.append(args[i])
        i += 1
    }
}

func writeOutput(_ text: String) {
    if let path = outputFile {
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
    } else {
        print(text, terminator: "")
    }
}

if filteredArgs.count < 2 {
    FileHandle.standardError.write("Usage: cal-helper [--output file] events <from> <to> <limit> [excludeCals]\n".data(using: .utf8)!)
    FileHandle.standardError.write("       cal-helper [--output file] calendars\n".data(using: .utf8)!)
    FileHandle.standardError.write("       cal-helper [--output file] delete <eventId> <occurrenceStart> <this|future>\n".data(using: .utf8)!)
    exit(1)
}

let command = filteredArgs[1]

switch command {
case "calendars":
    let calendars = store.calendars(for: .event)
    var out = ""
    for cal in calendars {
        out += "• \(cal.title)\n"
        out += "    UID: \(cal.calendarIdentifier)\n"
    }
    writeOutput(out)

case "events":
    guard filteredArgs.count >= 5 else {
        FileHandle.standardError.write("Usage: cal-helper events <fromDate> <toDate> <limit> [excludeCals]\n".data(using: .utf8)!)
        exit(1)
    }

    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd"

    guard let fromDate = df.date(from: filteredArgs[2]),
          let toDateRaw = df.date(from: filteredArgs[3]),
          let limit = Int(filteredArgs[4]) else {
        FileHandle.standardError.write("Invalid arguments. Dates must be YYYY-MM-DD, limit must be integer.\n".data(using: .utf8)!)
        exit(1)
    }

    let toDate = Calendar.current.date(byAdding: .day, value: 1, to: toDateRaw)!

    var excludedNames = Set<String>()
    if filteredArgs.count > 5 {
        let excl = filteredArgs[5]
        for name in excl.split(separator: ",") {
            excludedNames.insert(String(name))
        }
    }

    let allCalendars = store.calendars(for: .event)
    let calendars = allCalendars.filter { !excludedNames.contains($0.title) }

    let predicate = store.predicateForEvents(withStart: fromDate, end: toDate, calendars: calendars)
    var events = store.events(matching: predicate)

    events.sort { ($0.startDate ?? Date.distantPast) < ($1.startDate ?? Date.distantPast) }

    if events.count > limit {
        events = Array(events.prefix(limit))
    }

    var byCalendar: [String: [EKEvent]] = [:]
    for event in events {
        let calName = event.calendar?.title ?? "Unknown"
        byCalendar[calName, default: []].append(event)
    }

    var output = ""
    for (calName, calEvents) in byCalendar.sorted(by: { $0.key < $1.key }) {
        output += "\(calName):\(CAL_SEP)\n"
        for event in calEvents {
            let title = event.title ?? "Untitled"
            let location = event.location ?? ""
            let notes = (event.notes ?? "").replacingOccurrences(of: "\n", with: " ")
            let url = event.url?.absoluteString ?? ""
            let uid = event.eventIdentifier ?? ""

            var datetimeStr: String
            if event.isAllDay {
                let startStr = formatDateOnly(event.startDate)
                let endStr = formatDateOnly(event.endDate)
                datetimeStr = startStr == endStr ? startStr : "\(startStr) - \(endStr)"
            } else {
                datetimeStr = "\(formatDate(event.startDate)) - \(formatDate(event.endDate))"
            }

            output += "\(EVENT_SEP)\(title)"
            output += "\(FIELD_SEP)\(datetimeStr)"
            if !location.isEmpty { output += "\(FIELD_SEP)location: \(location)" }
            if !notes.isEmpty { output += "\(FIELD_SEP)notes: \(notes)" }
            if !url.isEmpty { output += "\(FIELD_SEP)url: \(url)" }
            output += "\(FIELD_SEP)uid: \(uid)"
            output += "\n"
        }
    }

    writeOutput(output)

case "delete":
    // delete <eventIdentifier> <occurrenceStart> <this|future>
    // occurrenceStart is the start exactly as `events` prints it (yyyy-MM-dd'T'HH:mm:ss, or yyyy-MM-dd
    // for all-day). Recurring occurrences share one eventIdentifier, so the start picks the occurrence.
    // Outcomes go through writeOutput as OK/ERROR records and exit 0, so the `open -W --output`
    // fallback can read them too. Exit 1 stays reserved for usage and access errors.
    guard filteredArgs.count >= 5 else {
        FileHandle.standardError.write("Usage: cal-helper delete <eventId> <occurrenceStart> <this|future>\n".data(using: .utf8)!)
        exit(1)
    }
    let eventId = filteredArgs[2]
    let start = filteredArgs[3]
    let spanArg = filteredArgs[4]

    func fail(_ msg: String) -> Never {
        writeOutput("ERROR\(FIELD_SEP)\(msg)")
        exit(0)
    }

    guard spanArg == "this" || spanArg == "future" else { fail("span must be 'this' or 'future'") }

    let dayFormat = DateFormatter()
    dayFormat.dateFormat = "yyyy-MM-dd"
    guard start.count >= 10, let dayStart = dayFormat.date(from: String(start.prefix(10))) else {
        fail("occurrence must be YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss")
    }
    let dayEnd = Calendar.current.date(byAdding: .day, value: 1, to: dayStart)!

    let predicate = store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: nil)
    let matches = store.events(matching: predicate).filter { ev in
        ev.eventIdentifier == eventId &&
            (formatDate(ev.startDate) == start || (ev.isAllDay && formatDateOnly(ev.startDate) == start))
    }
    guard let ev = matches.first else {
        fail("No event with that ID starts at \(start). Take ID and Occurrence from calendar-list or calendar-search.")
    }
    guard matches.count == 1 else { fail("\(matches.count) events match that ID and start; refusing to delete.") }
    guard ev.calendar.allowsContentModifications else {
        fail("Calendar \"\(ev.calendar.title)\" is read-only; this event cannot be deleted.")
    }

    let title = ev.title ?? "Untitled"
    let when = ev.isAllDay ? formatDateOnly(ev.startDate) : "\(formatDate(ev.startDate)) - \(formatDate(ev.endDate))"
    let calName = ev.calendar.title
    let scope = !ev.hasRecurrenceRules ? "single event"
        : spanArg == "future" ? "this and all future occurrences" : "this occurrence only"

    do {
        try store.remove(ev, span: spanArg == "future" ? .futureEvents : .thisEvent, commit: true)
    } catch {
        fail("Delete failed: \(error.localizedDescription)")
    }
    writeOutput("OK\(FIELD_SEP)\(title)\(FIELD_SEP)\(when)\(FIELD_SEP)\(calName)\(FIELD_SEP)\(scope)")

default:
    FileHandle.standardError.write("Unknown command: \(command)\n".data(using: .utf8)!)
    exit(1)
}
