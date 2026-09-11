import SwiftUI
import UIKit

/// Your data, and the writing voice the assistant drafts in.
///
/// Both of these existed on the web only. Export in particular is not a
/// convenience: a phone-only owner had no way to get their memory out of the
/// assistant at all, and no way to erase it, which is not a thing that should
/// depend on owning a laptop.
struct MemoryDataScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var exporting = false
    @State private var exported: ExportedFile?
    @State private var forgetting = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Take your data with you").font(.headline)
                        Text("The saved facts, knowledge-graph connections, people profiles, and writing voice that shape recall. The export never includes credentials or embeddings.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button {
                        export()
                    } label: {
                        HStack(spacing: 8) {
                            if exporting { ProgressView() }
                            Text(exporting ? "Preparing…" : "Export memory")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, fillsWidth: true))
                    .disabled(exporting)
                }
                .assistantPanel(in: colorScheme)

                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Forget long-term memory").font(.headline)
                        Text("Permanently deletes saved facts, graph connections, voice samples, and the learned voice profile. Chats, goals, people records, and connected accounts are left intact.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    AssistantConfirmationButton(
                        "Forget long-term memory",
                        confirmationTitle: "Erase memory and voice",
                        hint: "This cannot be undone.",
                        fillsWidth: true
                    ) {
                        forgetting = true
                        _ = await model.forgetLongTermMemory()
                        forgetting = false
                    }
                    .disabled(forgetting)
                    Text("Erasure keeps only anonymous content hashes, so forgotten facts are not picked up again the next time they are mentioned.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .assistantPanel(in: colorScheme)
            }
            .padding(16)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background(AssistantTheme.canvas(for: colorScheme).ignoresSafeArea())
        .navigationTitle("Your data")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $exported) { file in
            ShareSheet(url: file.url)
        }
    }

    private func export() {
        exporting = true
        Task {
            if let url = await model.exportMemoryFile() { exported = ExportedFile(url: url) }
            exporting = false
        }
    }
}

/// A temporary file on its way to the share sheet.
private struct ExportedFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// The system share sheet. SwiftUI's ShareLink wants its item up front, and the
/// export does not exist until the server has been asked for it.
private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Edit the distilled voice rather than only the samples behind it.
///
/// iOS could upload sent messages and clear them, but the profile those samples
/// produce — the description the drafting step actually reads — was web-only.
struct VoiceProfileEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var description = ""
    @State private var dos = ""
    @State private var donts = ""
    @State private var signature = ""
    @State private var loaded = false
    @State private var isSaving = false

    var body: some View {
        AssistantForm {
            Section {
                TextField(
                    "How you write: tone, sentence length, what you never do",
                    text: $description,
                    axis: .vertical
                )
                .lineLimit(3...10)
            } header: {
                Text("Your voice")
            } footer: {
                Text("This is what the assistant reads before it drafts anything on your behalf.")
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))

            Section {
                TextField("One per line", text: $dos, axis: .vertical)
                    .lineLimit(2...8)
            } header: {
                Text("Always")
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))

            Section {
                TextField("One per line", text: $donts, axis: .vertical)
                    .lineLimit(2...8)
            } header: {
                Text("Never")
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))

            Section("Sign-off") {
                TextField("How you end a message", text: $signature)
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .scrollContentBackground(.hidden)
        .assistantSubmenuChrome()
        .navigationTitle("Writing voice")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save") { save() }
                    .disabled(
                        isSaving
                            || !loaded
                            || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
        }
        .task {
            guard !loaded else { return }
            if let response = await model.voiceProfile() {
                description = response.voiceProfile.description
                dos = response.voiceProfile.dos.joined(separator: "\n")
                donts = response.voiceProfile.donts.joined(separator: "\n")
                signature = response.voiceProfile.signature
            }
            loaded = true
        }
    }

    private func save() {
        isSaving = true
        Task {
            let saved = await model.saveVoiceProfile(
                VoiceProfileMutation(
                    description: description,
                    dos: dos,
                    donts: donts,
                    signature: signature
                )
            )
            isSaving = false
            if saved { dismiss() }
        }
    }
}
