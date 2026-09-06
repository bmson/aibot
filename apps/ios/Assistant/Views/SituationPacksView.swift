import SwiftUI

struct SituationPacksView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var overview: SituationOverview?
    @State private var title = ""
    @State private var error: String?
    @State private var creating = false
    @State private var busy = false
    @State private var creationKey = UUID().uuidString

    var body: some View {
        List {
            Section {
                Text("Keep a plan, its linked cards, and the reasons behind your choices together.")
                    .font(.subheadline).foregroundStyle(.secondary)
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            if let overview {
                if overview.packs.isEmpty {
                    ContentUnavailableView(
                        "Start with one situation", systemImage: "square.stack.3d.up",
                        description: Text(
                            "A weekend, a job search, or a project. Attach real cards and commitments as you go."
                        ))
                }
                ForEach(overview.packs) { pack in
                    NavigationLink {
                        SituationPackDetail(packId: pack.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(pack.title).font(.subheadline.weight(.semibold))
                            Text(
                                pack.affectedIds.isEmpty
                                    ? "\(pack.data.items.count) linked items"
                                    : "\(pack.affectedIds.count) items need review"
                            )
                            .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }
                }
            } else if error == nil {
                ProgressView("Loading packs…")
            }
        }
        .navigationTitle("Situation packs")
        .scrollContentBackground(.hidden)
        .background(AssistantTheme.canvas(for: colorScheme))
        .tint(AssistantTheme.accent(for: colorScheme))
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Create pack", systemImage: "plus") { creating = true }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $creating) {
            NavigationStack {
                Form {
                    TextField("A weekend, a job search, a project…", text: $title)
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                    Button(busy ? "Creating…" : "Create pack") { Task { await create() } }
                        .disabled(
                            busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .navigationTitle("New pack").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { creating = false }.disabled(busy)
                    }
                }
                .interactiveDismissDisabled(busy)
            }
        }
    }

    private func load() async {
        do {
            overview = try await model.loadSituationPacks()
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await model.changeSituationPack(
                .init(action: "create", title: title, creationKey: creationKey))
            guard result.ok else {
                error = result.error
                return
            }
            creating = false
            title = ""
            creationKey = UUID().uuidString
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

struct SituationPackDetail: View {
    let packId: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var overview: SituationOverview?
    @State private var error: String?
    @State private var notice: String?
    @State private var busy = false
    @State private var editing: SituationItem?
    @State private var newItem = false
    @State private var editVersion = 0
    @State private var decisionVersion = 0
    @State private var decision: SituationDecision?
    @State private var preview: SituationPreview?
    private var pack: SituationPack? { overview?.packs.first { $0.id == packId } }
    private let lanes = [("plan", "Plan"), ("i_owe", "I owe"), ("waiting_on", "Waiting on")]

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
                if let notice {
                    Section {
                        Text(notice).font(.footnote).foregroundStyle(.secondary).id("status")
                    }
                }
                if let pack {
                    Section {
                        Text(
                            pack.affectedIds.isEmpty
                                ? "No linked changes to review"
                                : "\(pack.affectedIds.count) linked items need a look"
                        )
                        .font(.subheadline.weight(.medium))
                        Text("Checked against stored sources, not live availability.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let preview { previewSection(preview, pack: pack).id("preview") }
                    ForEach(lanes, id: \.0) { lane, name in
                        Section(name) {
                            let items = pack.data.items.filter { $0.lane == lane }
                            if items.isEmpty {
                                Text("Nothing here yet.").font(.subheadline).foregroundStyle(
                                    .secondary)
                            }
                            ForEach(items) { item in itemRow(item, pack: pack) }
                        }
                    }
                    Section {
                        Button("Add linked item", systemImage: "plus") {
                            editVersion = pack.version
                            newItem = true
                            editing = SituationItem()
                        }
                    }
                    Section("Choices & reasons") {
                        ForEach(pack.data.decisions) { choice in
                            Button {
                                decisionVersion = pack.version
                                decision = choice
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(
                                        "\(choice.outcome == "chosen" ? "Chosen" : "Passed on") · \(choice.option)"
                                    ).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                                    Text(choice.reason).font(.subheadline).foregroundStyle(
                                        .secondary)
                                    Text(
                                        choice.scope == "preference"
                                            ? "Confirmed preference"
                                            : "For this situation only\(choice.confirmed ? "" : " · proposed")"
                                    )
                                    .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        Button("Record a decision", systemImage: "pencil") {
                            decisionVersion = pack.version
                            decision = SituationDecision()
                        }
                    }
                    Section {
                        Button("Discuss next steps", systemImage: "bubble.left") {
                            model.discussSituationPack(id: pack.id)
                        }
                        Text(
                            "Reviewing or applying a pack change does not send messages, change bookings, or complete commitments."
                        )
                        .font(.caption).foregroundStyle(.secondary)
                        Button("Archive pack", systemImage: "archivebox") {
                            Task {
                                if await run(
                                    .init(action: "archive", packId: pack.id, version: pack.version)
                                ) {
                                    dismiss()
                                }
                            }
                        }
                    }
                } else if overview == nil && error == nil {
                    ProgressView("Loading plan…")
                } else if error == nil {
                    ContentUnavailableView(
                        "Pack unavailable", systemImage: "archivebox",
                        description: Text("It may have been archived on another device."))
                }
            }
            .font(.subheadline)
            .scrollContentBackground(.hidden)
            .background(AssistantTheme.canvas(for: colorScheme))
            .tint(AssistantTheme.accent(for: colorScheme))
            .navigationTitle(pack?.title ?? "Situation pack")
            .assistantSubmenuChrome()
            .disabled(busy)
            .task { await load() }
            .refreshable { await load() }
            .sheet(item: $editing) { item in
                if let pack {
                    SituationItemEditor(
                        item: item, pack: pack, sources: overview?.sources ?? [], isNew: newItem
                    ) { updated in
                        await run(
                            .init(
                                action: newItem ? "item" : "preview", packId: pack.id,
                                version: editVersion, item: updated))
                    }
                }
            }
            .sheet(item: $decision) { choice in
                if let pack {
                    SituationDecisionEditor(decision: choice) { updated in
                        await run(
                            .init(
                                action: "decision", packId: pack.id, version: decisionVersion,
                                decision: updated))
                    }
                }
            }
            .onChange(of: preview?.id) { _, id in
                if id != nil {
                    proxy.scrollTo("preview", anchor: .top)
                } else if notice != nil {
                    proxy.scrollTo("status", anchor: .top)
                }
            }
        }
    }

    private func itemRow(_ item: SituationItem, pack: SituationPack) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.title).font(.subheadline.weight(.semibold))
            if pack.affectedIds.contains(item.id) {
                Label("Needs review", systemImage: "exclamationmark.circle").font(.caption)
                    .foregroundStyle(.orange)
            }
            if !item.details.isEmpty { Text(item.details).foregroundStyle(.secondary) }
            if let snapshot = item.snapshot {
                DisclosureGroup(
                    "\(item.source?.kind == "card" ? "Saved card" : "Commitment") · \(snapshot.state)"
                ) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(snapshot.title).fontWeight(.medium)
                        Text(snapshot.details)
                    }
                    .font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(
                        .vertical, 6)
                }.font(.caption)
            }
            if !item.dependsOn.isEmpty {
                Text(
                    "Depends on \(item.dependsOn.compactMap { id in pack.data.items.first { $0.id == id }?.title }.joined(separator: ", "))"
                )
                .font(.caption).foregroundStyle(.secondary)
            }
            if pack.changes.contains(where: { $0.itemId == item.id }) {
                Text("The linked source changed. Review it before relying on it.").font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button("Review / change") {
                    editVersion = pack.version
                    newItem = false
                    preview = nil
                    editing = item
                }.buttonStyle(.bordered)
                if item.needsReview {
                    Button("Reviewed") {
                        Task {
                            _ = await run(
                                .init(
                                    action: "reviewed", packId: pack.id, version: pack.version,
                                    itemId: item.id))
                        }
                    }.buttonStyle(.borderless)
                }
            }.controlSize(.small)
        }.padding(.vertical, 6)
    }
    private func previewSection(_ preview: SituationPreview, pack: SituationPack) -> some View {
        Section("Rehearsal · not applied") {
            ForEach([("Before", preview.before), ("After", preview.after)], id: \.0) { name, item in
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).font(.caption).foregroundStyle(.secondary)
                    Text(item.title).fontWeight(.medium)
                    if !item.details.isEmpty { Text(item.details) }
                    if let snapshot = item.snapshot {
                        Text("\(snapshot.title) · \(snapshot.state)").font(.caption)
                        Text(snapshot.details).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Text(
                "Review next: \(preview.affectedIds.filter { $0 != preview.after.id }.compactMap { id in pack.data.items.first { $0.id == id }?.title }.joined(separator: ", "))"
            )
            ForEach(preview.unknowns, id: \.self) {
                Text($0).font(.caption).foregroundStyle(.secondary)
            }
            Button("Apply to pack") {
                Task {
                    _ = await run(.init(action: "apply", packId: pack.id, previewId: preview.id))
                }
            }.buttonStyle(.borderedProminent)
            Button("Discard preview") {
                Task {
                    _ = await run(
                        .init(action: "dismiss_preview", packId: pack.id, previewId: preview.id))
                }
            }
        }
    }
    private func load() async {
        do {
            overview = try await model.loadSituationPacks()
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func run(_ command: SituationCommand) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            let result = try await model.changeSituationPack(command)
            guard result.ok else {
                error = result.error
                return false
            }
            preview = result.preview
            notice =
                result.preview != nil
                ? "Preview only. Your plan has not changed."
                : command.action == "apply"
                    ? "Pack updated. Review its dependent items next. Nothing outside this pack changed."
                    : "Saved."
            await load()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct SituationItemEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var item: SituationItem
    let pack: SituationPack
    let sources: [SituationSourceOption]
    let isNew: Bool
    let save: (SituationItem) async -> Bool
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Item") {
                    TextField("Title", text: $item.title)
                    TextField("Notes", text: $item.details, axis: .vertical).lineLimit(3...8)
                    Picker("Lane", selection: $item.lane) {
                        Text("Plan").tag("plan")
                        Text("I owe").tag("i_owe")
                        Text("Waiting on").tag("waiting_on")
                    }
                    Picker(
                        "Source",
                        selection: Binding(
                            get: { item.source.map { "\($0.kind):\($0.id)" } ?? "" },
                            set: { key in
                                if let source = sources.first(where: { $0.key == key }) {
                                    item.source = .init(kind: source.kind, id: source.id)
                                } else if key.isEmpty {
                                    item.source = nil
                                }
                            })
                    ) {
                        Text("Planning note · no source").tag("")
                        if let source = item.source,
                            !sources.contains(where: {
                                $0.id == source.id && $0.kind == source.kind
                            })
                        {
                            Text("Current source (not active)").tag("\(source.kind):\(source.id)")
                        }
                        ForEach(sources, id: \.key) { Text($0.title).tag($0.key) }
                    }
                }
                Section("Depends on") {
                    ForEach(pack.data.items.filter { $0.id != item.id }) { other in
                        Toggle(
                            other.title,
                            isOn: Binding(
                                get: { item.dependsOn.contains(other.id) },
                                set: { enabled in
                                    item.dependsOn.removeAll { $0 == other.id }
                                    if enabled { item.dependsOn.append(other.id) }
                                }))
                    }
                }
                if failed {
                    Text(
                        "Could not save. Close this form to see the error and refresh the pack before retrying."
                    ).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle(isNew ? "Linked item" : "Rehearse change")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isNew ? "Add" : "Preview") {
                        Task {
                            busy = true
                            if await save(item) { dismiss() } else { failed = true }
                            busy = false
                        }
                    }.disabled(
                        busy || item.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }
}

private struct SituationDecisionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var decision: SituationDecision
    let save: (SituationDecision) async -> Bool
    @State private var busy = false
    @State private var failed = false
    var body: some View {
        NavigationStack {
            Form {
                TextField("Option", text: $decision.option)
                Picker("Decision", selection: $decision.outcome) {
                    Text("Chosen").tag("chosen")
                    Text("Rejected").tag("rejected")
                }
                TextField("Why?", text: $decision.reason, axis: .vertical).lineLimit(3...8)
                Toggle(
                    "Remember as a lasting preference",
                    isOn: Binding(
                        get: { decision.scope == "preference" },
                        set: { decision.scope = $0 ? "preference" : "situation" }))
                Text(
                    "Off means this choice applies only to this situation. Saving confirms the reason in your own words."
                ).font(.caption).foregroundStyle(.secondary)
                if failed {
                    Text(
                        "Could not save. Close this form to see the error and refresh before retrying."
                    ).font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("Choice & reason").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            busy = true
                            if await save(decision) { dismiss() } else { failed = true }
                            busy = false
                        }
                    }.disabled(
                        busy
                            || decision.option.trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty
                            || decision.reason.trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty
                    )
                }
            }
            .interactiveDismissDisabled(busy)
        }
    }
}
