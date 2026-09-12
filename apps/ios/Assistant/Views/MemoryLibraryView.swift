import SwiftUI

/// The whole memory library, paged and filtered.
///
/// The Memory screen's fact list comes from the workspace payload, which
/// carries the first 80 owner facts — enough for a summary, and a hard ceiling
/// on what the phone could ever show. Past the 80th fact there was simply no
/// way to look. This screen runs the same query the web library runs, so both
/// clients reach the same rows through the same filters.
struct MemoryLibraryScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme

    @State private var query = MemoryLibraryQuery()
    @State private var search = ""
    @State private var response = MemoryLibraryResponse.empty
    @State private var loading = false
    @State private var loaded = false
    @State private var pendingRowID: String?
    @State private var correctingRow: MemoryLibraryRow?

    /// The domains the extractor assigns. Fixed rather than derived so the
    /// picker does not change shape as the library fills up.
    private let domains = [
        ("", "Any area"),
        ("identity", "Identity"),
        ("work", "Work"),
        ("home", "Home"),
        ("relationships", "Relationships"),
        ("preferences", "Preferences"),
        ("health", "Health"),
        ("other", "Other"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                filters
                if loading && response.rows.isEmpty {
                    AssistantLoadingState(title: "Loading your memory library")
                } else if response.rows.isEmpty {
                    AssistantEmptyState(
                        loaded ? "Nothing matches those filters" : "Memory library",
                        systemImage: "tray",
                        description: loaded ? "Clear a filter to widen the search." : nil
                    )
                } else {
                    resultSummary
                    ForEach(response.rows) { row in
                        factCard(row)
                    }
                    pager
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle("Memory library")
        .assistantSubmenuChrome()
        .searchable(text: $search, prompt: "Search saved memories")
        .onSubmit(of: .search) { apply { $0.search = search } }
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(item: $correctingRow, onDismiss: { Task { await load() } }) { row in
            NavigationStack { MemoryEditor(row: row) }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("State", selection: stateBinding) {
                Text("In use").tag("in-use")
                Text("Held for review").tag("review")
            }
            .pickerStyle(.segmented)

            Picker("Area", selection: domainBinding) {
                ForEach(domains, id: \.0) { value, label in
                    Text(label).tag(value)
                }
            }
            Picker("Verification", selection: filterBinding) {
                Text("Any").tag("all")
                Text("Verified by you").tag("verified")
                Text("Not yet tidied").tag("untidied")
            }
            Picker("Connections", selection: connectivityBinding) {
                Text("Any").tag("all")
                Text("Connected").tag("connected")
                Text("Not connected").tag("unconnected")
            }
            // The server sends these with every page; without a control for
            // them two of the web library's filters were unreachable here.
            if !response.subjects.isEmpty {
                Picker("About", selection: subjectBinding) {
                    Text("Anyone").tag("")
                    ForEach(response.subjects) { subject in
                        Text(subject.label).tag(subject.id)
                    }
                }
            }
            Picker("Age", selection: ageBinding) {
                Text("Any age").tag("")
                Text("Last 30 days").tag("30")
                Text("Last 90 days").tag("90")
                Text("Last year").tag("365")
            }
            if !response.sources.isEmpty {
                Picker("Source", selection: sourceBinding) {
                    Text("Any source").tag("")
                    ForEach(response.sources, id: \.self) { source in
                        Text(source.sentenceCaseIdentifier).tag(source)
                    }
                }
            }
        }
        .assistantPanel(in: colorScheme)
    }

    private var resultSummary: some View {
        Text("\(response.total) \(response.total == 1 ? "memory" : "memories")")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func factCard(_ row: MemoryLibraryRow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(row.content)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            AssistantFlowLayout(spacing: 8) {
                if !row.subjectLabel.isEmpty { memoryTag(row.subjectLabel) }
                if !row.domain.isEmpty { memoryTag(row.domain.sentenceCaseIdentifier) }
                if row.ownerConfirmed { memoryTag("Verified") }
                if row.pinned { memoryTag("Pinned") }
                if !row.organized { memoryTag("Not yet tidied") }
                memoryTag(
                    row.connectionCount == 1
                        ? "1 connection"
                        : "\(row.connectionCount) connections"
                )
            }
            actions(row)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    @ViewBuilder
    private func actions(_ row: MemoryLibraryRow) -> some View {
        AssistantFlowLayout(spacing: 9) {
            if query.state == "review" {
                Button("Approve", systemImage: "checkmark") { perform(row, action: "approve") }
                    .buttonStyle(AssistantActionButtonStyle(kind: .primary, compact: true))
                AssistantConfirmationButton("Reject", systemImage: "xmark", compact: true) {
                    await act(row, action: "reject")
                }
            } else {
                if !row.ownerConfirmed {
                    Button("Confirm", systemImage: "checkmark.seal") {
                        perform(row, action: "confirm")
                    }
                    .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                }
                Menu {
                    Section("In conversations") {
                        Button("Always in profile") { perform(row, action: "prominence", prominence: "always") }
                        Button("When relevant") { perform(row, action: "prominence", prominence: "auto") }
                        // Web hides this for a fact about someone else, which
                        // never auto-surfaces anyway; an empty subject is the
                        // owner's own fact.
                        if row.subjectLabel.isEmpty {
                            Button("Minor detail") { perform(row, action: "prominence", prominence: "minor") }
                        }
                    }
                    Button("Correct", systemImage: "pencil") { correctingRow = row }
                } label: {
                    Label("Manage", systemImage: "ellipsis.circle")
                }
                .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
                AssistantConfirmationButton(
                    "Forget",
                    hint: "Removes this fact and prevents relearning it from the same source text.",
                    compact: true
                ) {
                    await act(row, action: "forget")
                }
            }
        }
        .font(.subheadline)
        .disabled(pendingRowID == row.id)
    }

    private func perform(_ row: MemoryLibraryRow, action: String, prominence: String? = nil) {
        Task { await act(row, action: action, prominence: prominence) }
    }

    /// Acting on a row changes what the current page contains, so the list is
    /// reloaded rather than left showing a row that no longer qualifies.
    private func act(_ row: MemoryLibraryRow, action: String, prominence: String? = nil) async {
        pendingRowID = row.id
        _ = await model.updateMemory(id: row.id, action: action, prominence: prominence)
        pendingRowID = nil
        await load()
    }

    private func memoryTag(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                AssistantTheme.sunken(for: colorScheme),
                in: Capsule()
            )
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var pager: some View {
        if response.totalPages > 1 {
            HStack {
                Button("Previous") { apply { $0.page = max(1, $0.page - 1) } }
                    .disabled(response.page <= 1 || loading)
                Spacer(minLength: 8)
                Text("Page \(response.page) of \(response.totalPages)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button("Next") { apply { $0.page = min(response.totalPages, $0.page + 1) } }
                    .disabled(response.page >= response.totalPages || loading)
            }
            .buttonStyle(AssistantActionButtonStyle(kind: .secondary, compact: true))
        }
    }

    // Every filter resets to page 1: keeping the old page number would land the
    // owner on an empty page whenever the narrower filter has fewer of them.
    private func binding(_ keyPath: WritableKeyPath<MemoryLibraryQuery, String>) -> Binding<String> {
        Binding(
            get: { query[keyPath: keyPath] },
            set: { value in apply { $0[keyPath: keyPath] = value } }
        )
    }

    private var stateBinding: Binding<String> { binding(\.state) }
    private var domainBinding: Binding<String> { binding(\.domain) }
    private var filterBinding: Binding<String> { binding(\.filter) }
    private var connectivityBinding: Binding<String> { binding(\.connectivity) }
    private var subjectBinding: Binding<String> { binding(\.subjectId) }
    private var ageBinding: Binding<String> { binding(\.ageDays) }
    private var sourceBinding: Binding<String> { binding(\.source) }

    private func apply(_ change: (inout MemoryLibraryQuery) -> Void) {
        var next = query
        let before = next
        change(&next)
        // A page change is the one edit that should keep its own page number.
        if next.page == before.page { next.page = 1 }
        guard next != query else { return }
        query = next
        Task { await load() }
    }

    private func load() async {
        loading = true
        if let result = await model.memoryLibrary(query) { response = result }
        loading = false
        loaded = true
    }
}
