import Foundation

/// Every date, time, age, duration and number the phone writes for a person (docs/i18n.md, "On the phone"), in the
/// phone's own locale, as the Mac's `src/shared/i18n/format.ts` writes the desktop's. The short unit forms (`5m`, `2h`,
/// `under 1m`) are the catalog's `phoneFormat…` messages, filled with numbers written here.
public enum PhoneFormats {
    /// The phone's own locale: its language and region from iOS Settings.
    public static var locale: Locale { .current }

    /// A whole number with no grouping, as the Mac writes one inside an age or a duration.
    static func whole(_ number: Int, locale: Locale) -> String {
        number.formatted(.number.locale(locale).grouping(.never))
    }

    /// A short age beside a fact, as the feed writes it: `now`, `5m`, `2h`, `3d` (`feedRelativeAge`, src/shared/relativeAge.ts).
    public static func relativeAge(_ at: Double, now: Double, locale: Locale = locale) -> String {
        let seconds = Int((max(0, now - at) / 1000).rounded(.down))
        if seconds < 60 { return PhoneMessages.phoneFormatNow() }
        let minutes = seconds / 60
        if minutes < 60 { return PhoneMessages.phoneFormatMinutes(minutes: whole(minutes, locale: locale)) }
        let hours = minutes / 60
        return hours < 24 ? PhoneMessages.phoneFormatHours(hours: whole(hours, locale: locale)) : PhoneMessages.phoneFormatDays(days: whole(hours / 24, locale: locale))
    }

    /// Whole minutes as 2d 3h, 1h 35m or 4m (`formatDurationShort`, src/shared/quotaSignals.ts).
    public static func durationShort(_ ms: Double, locale: Locale = locale) -> String {
        let total = max(0, Int((ms / 60_000).rounded(.toNearestOrAwayFromZero)))
        let days = total / (60 * 24), hours = (total % (60 * 24)) / 60, minutes = total % 60
        let d = whole(days, locale: locale), h = whole(hours, locale: locale), m = whole(minutes, locale: locale)
        if days > 0 { return hours > 0 ? PhoneMessages.phoneFormatDaysHours(days: d, hours: h) : PhoneMessages.phoneFormatDays(days: d) }
        if hours > 0 { return minutes > 0 ? PhoneMessages.phoneFormatHoursMinutes(hours: h, minutes: m) : PhoneMessages.phoneFormatHours(hours: h) }
        return PhoneMessages.phoneFormatMinutes(minutes: m)
    }

    /// A checks run's length: `under 1m`, `15m`, `1h 05m`.
    public static func checksDuration(_ ms: Double, locale: Locale = locale) -> String {
        let minutes = Int((max(0, ms) / 60_000).rounded(.down))
        if minutes < 1 { return PhoneMessages.phoneFormatUnderMinute() }
        if minutes < 60 { return PhoneMessages.phoneFormatMinutes(minutes: whole(minutes, locale: locale)) }
        let rest = (minutes % 60).formatted(.number.locale(locale).grouping(.never).precision(.integerLength(2...)))
        return PhoneMessages.phoneFormatHoursMinutes(hours: whole(minutes / 60, locale: locale), minutes: rest)
    }

    /// The time of day: `3:12 PM`.
    public static func time(_ date: Date, locale: Locale = locale) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale))
    }

    /// The date and the time of day: `Oct 5, 2026 at 3:12 PM`.
    public static func dateTime(_ date: Date, locale: Locale = locale) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale))
    }

    /// The month and day alone: `Oct 5`.
    public static func monthDay(_ date: Date, locale: Locale = locale) -> String {
        date.formatted(Date.FormatStyle(locale: locale).month(.abbreviated).day())
    }

    /// The time of day with its zone, and the date in front when it is not today, as the Mac's clock writes it.
    public static func clock(_ at: Double, now: Double, zone: TimeZone, locale: Locale = locale) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = Date(timeIntervalSince1970: at / 1000)
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate(
            calendar.isDate(date, inSameDayAs: Date(timeIntervalSince1970: now / 1000)) ? "jmmz" : "MMMdjmmz")
        return formatter.string(from: date)
    }
}
