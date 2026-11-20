import InfinitaryPush
import UserNotifications

/// INF-4794: Infinitary's notification part (docs/ios.md, "Card pushes"). Each card push from the relay carries
/// only a card sealed for this phone; this part opens it with the key the app keeps in their push keychain group
/// and shows the card's title and first line. A push it cannot open shows the relay's "A card is ready".
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        // A push it cannot open keeps the relay's own words, "A card is ready", and opens no card.
        guard let notice = PhonePushSeal.notice(request.content.userInfo, key: PhonePushStore.load()?.key),
              let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        content.title = notice.title
        content.body = notice.body
        content.threadIdentifier = notice.cardID
        // The card it opens, and which push of it this is: a withdrawal of another push leaves this notification.
        content.userInfo = PhonePushSeal.userInfo(for: notice)
        contentHandler(content)
    }

    /// iOS ends the part's time before it answered: the push shows as the relay sent it, "A card is ready".
    override func serviceExtensionTimeWillExpire() {}
}
