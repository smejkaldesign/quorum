import EventKit
import Foundation

// reads upcoming events from the Calendar app on this Mac; macOS asks once, and only when the user turns it on in Quorum
enum CalendarReader {
    static let store = EKEventStore()

    static func status() -> String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return "granted"
        case .notDetermined: return "notDetermined"
        default: return "denied"
        }
    }

    static func request(id: String?) async {
        _ = try? await store.requestFullAccessToEvents()
        Emit.send(["event": "calResult", "id": id ?? "", "status": status()])
    }

    static func events(days: Int, id: String?) {
        guard status() == "granted" else {
            Emit.send(["event": "calResult", "id": id ?? "", "status": status(), "events": []])
            return
        }
        let start = Date()
        let end = Calendar.current.date(byAdding: .day, value: max(1, days) + 1, to: Calendar.current.startOfDay(for: start))!
        let iso = ISO8601DateFormatter()
        let found = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
            .filter { !$0.isAllDay && $0.status != .canceled }
            .sorted { $0.startDate < $1.startDate }
            .prefix(200)
            .map { e -> [String: Any] in
                ["id": e.eventIdentifier ?? UUID().uuidString, "title": e.title ?? "Untitled", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate), "calendar": e.calendar.title, "attendees": attendees(e), "item": e.calendarItemIdentifier, "recurring": e.hasRecurrenceRules, "location": e.location ?? "", "url": e.url?.absoluteString ?? "", "notes": String((e.notes ?? "").prefix(1500))]
            }
        Emit.send(["event": "calResult", "id": id ?? "", "status": "granted", "events": Array(found)])
    }

    // name and email of each person on the invite, used only to check the never-listen list
    static func attendees(_ e: EKEvent) -> [[String: String]] {
        (e.attendees ?? []).compactMap { p in
            let url = p.url.absoluteString
            guard url.lowercased().hasPrefix("mailto:") else { return nil }
            return ["name": p.name ?? "", "email": String(url.dropFirst(7)).removingPercentEncoding ?? ""]
        }
    }
}
