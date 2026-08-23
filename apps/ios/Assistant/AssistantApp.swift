import SwiftUI

@main
struct AssistantApp: App {
    @StateObject private var model = AppModel()
    // Dark by default: the owner expects the conversation stage day and
    // night, and a silently followed system appearance read as a bug.
    @AppStorage(AssistantAppearance.defaultsKey) private var appearance = AssistantAppearance.dark

    init() {
        // Set the notification delegate and register categories before iOS can
        // deliver a launch response from a tapped notification.
        _ = NotificationManager.shared
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(appearance.colorScheme)
        }
    }
}
