import SwiftUI

/// Phone calls the assistant placed, and — while one is live — the question it
/// is waiting on you for and a way to hang up.
struct CallsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var calls: [PhoneCall]?

    var body: some View {
        Form {
            Group {
                if let calls {
                    if calls.isEmpty {
                        Text("No calls yet. Ask the assistant in chat to call someone for you.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(calls) { call in
                        NavigationLink {
                            CallDetailView(callID: call.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(call.title)
                                    if call.openCheckin != nil {
                                        Image(systemName: "questionmark.bubble.fill")
                                            .foregroundStyle(.orange)
                                            .accessibilityLabel("Needs your answer")
                                    }
                                }
                                Text("\(call.statusLabel) · \(call.summary ?? call.brief.goal)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Calls")
        .assistantSubmenuChrome()
        .task { calls = await model.loadPhoneCalls() }
        .refreshable { calls = await model.loadPhoneCalls() }
    }
}

private struct CallDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    let callID: String
    @State private var call: PhoneCall?
    @State private var answer = ""
    @State private var sending = false

    var body: some View {
        Form {
            Group {
                if let call {
                    Section {
                        LabeledContent("Status", value: call.statusLabel)
                        Text(call.brief.goal)
                        if let summary = call.summary { Text(summary).foregroundStyle(.secondary) }
                    }
                    if call.active {
                        if let checkin = call.openCheckin {
                            Section("The assistant is asking you") {
                                Text("“\(checkin.question)”")
                                TextField("Your answer", text: $answer, axis: .vertical)
                                Button(sending ? "Sending…" : "Send answer") {
                                    sending = true
                                    Task {
                                        if await model.answerCallCheckin(callId: call.id, checkinId: checkin.id, answer: answer) {
                                            answer = ""
                                        }
                                        sending = false
                                        await reload()
                                    }
                                }
                                .disabled(sending || answer.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                        Section {
                            Button("Hang up", role: .destructive) {
                                Task {
                                    _ = await model.hangUpCall(callId: call.id)
                                    await reload()
                                }
                            }
                        }
                    }
                    if !call.notes.isEmpty {
                        Section("Noted on the call") {
                            ForEach(call.notes, id: \.self) { Text($0) }
                        }
                    }
                    Section("Transcript") {
                        if call.transcript.isEmpty {
                            Text(call.active ? "Waiting for the conversation…" : "Nothing was said.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(call.transcript, id: \.self) { line in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(line.role == "assistant" ? "Assistant" : line.role == "caller" ? "Them" : "·")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(line.text)
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(call?.title ?? "Call")
        .assistantSubmenuChrome()
        .task {
            await reload()
            // Follow a live call: new lines and questions arrive every couple of seconds.
            while !Task.isCancelled, call?.active != false {
                try? await Task.sleep(for: .seconds(2))
                await reload()
            }
        }
    }

    private func reload() async {
        if let fresh = await model.loadPhoneCall(id: callID) { call = fresh }
    }
}
