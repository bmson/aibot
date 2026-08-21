import SwiftUI
import UIKit
@preconcurrency import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var isRequestingAuthorization = false
    @Published private(set) var authorizationError: String?
    @Published private(set) var pendingRoute: AssistantRoute?

    /// Wired up by AppModel: handles Approve/Deny actions taken directly on a
    /// notification without opening the app into the Approvals sheet first.
    var approvalDecisionHandler: (@MainActor (String, String) async -> Void)?

    private let center = UNUserNotificationCenter.current()

    static let attentionCategory = "ASSISTANT_ATTENTION"
    static let updateCategory = "ASSISTANT_UPDATE"
    static let approveAction = "ASSISTANT_APPROVE"
    static let denyAction = "ASSISTANT_DENY"

    private override init() {
        super.init()
        center.delegate = self
        registerCategories()
        Task { await refreshAuthorizationStatus() }
    }

    func requestAuthorization() async {
        guard !isRequestingAuthorization else { return }
        isRequestingAuthorization = true
        authorizationError = nil
        defer { isRequestingAuthorization = false }
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            authorizationError = "Notifications couldn’t be enabled. Try again."
        }
        await refreshAuthorizationStatus()
    }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await center.notificationSettings().authorizationStatus
    }

    @discardableResult
    func schedule(title: String, body: String, route: AssistantRoute?, approvalId: String? = nil) async -> Bool {
        let settings = await center.notificationSettings()
        authorizationStatus = settings.authorizationStatus
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
              UIApplication.shared.applicationState != .active else { return false }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "assistant-work"
        content.categoryIdentifier = route == .approvals ? Self.attentionCategory : Self.updateCategory
        if let route {
            content.userInfo["route"] = route.rawValue
        }
        if let approvalId {
            content.userInfo["approvalId"] = approvalId
        }

        let request = UNNotificationRequest(
            identifier: "assistant-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }

    /// Mirrors the pending-approval count onto the app icon badge. Zero clears
    /// it. Local notifications never touch the badge themselves, so this is
    /// the single place the number is asserted.
    func updateBadge(_ count: Int) async {
        do {
            try await center.setBadgeCount(max(0, count))
        } catch {
            // Badge failure is cosmetic — never surface it as an app error.
        }
    }

#if DEBUG
    @discardableResult
    func schedulePreview() async -> Bool {
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            await requestAuthorization()
            status = authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return false }

        let content = UNMutableNotificationContent()
        content.title = "Assistant needs you"
        content.body = "A decision is ready to review."
        content.sound = .default
        content.threadIdentifier = "assistant-work"
        content.categoryIdentifier = Self.attentionCategory
        content.userInfo["route"] = AssistantRoute.approvals.rawValue

        let request = UNNotificationRequest(
            identifier: "assistant-preview",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        )
        do {
            try await center.add(request)
            return true
        } catch {
            return false
        }
    }
#endif

    func consumePendingRoute() {
        pendingRoute = nil
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Notifications are normally suppressed while the app is active, but a
        // decision request is worth a banner even then: the owner may be on a
        // different screen and the work is parked until they respond.
        if notification.request.content.categoryIdentifier == Self.attentionCategory {
            return [.banner, .sound]
        }
        return []
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo

        // Inline Approve/Deny actions resolve the approval in place and skip
        // navigation entirely — the handler refreshes the model behind them.
        if response.actionIdentifier == Self.approveAction
            || response.actionIdentifier == Self.denyAction,
            let approvalId = userInfo["approvalId"] as? String {
            let decision = response.actionIdentifier == Self.approveAction ? "approved" : "denied"
            if let handler = await MainActor.run(body: { self.approvalDecisionHandler }) {
                await handler(approvalId, decision)
                return
            }
        }

        let rawRoute = userInfo["route"] as? String
        let route = rawRoute.flatMap(AssistantRoute.init(rawValue:))
        guard let route else { return }
        await MainActor.run { self.pendingRoute = route }
    }

    private func registerCategories() {
        // Authentication is required for both: an approval button that works
        // from the lock screen without unlocking would let anyone holding the
        // phone authorize an outward-facing action.
        let approve = UNNotificationAction(
            identifier: Self.approveAction,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: Self.denyAction,
            title: "Deny",
            options: [.authenticationRequired, .destructive]
        )
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.attentionCategory,
                actions: [approve, deny],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Decision ready",
                options: []
            ),
            UNNotificationCategory(
                identifier: Self.updateCategory,
                actions: [],
                intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Assistant update",
                options: []
            ),
        ])
    }
}
