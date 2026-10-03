import SwiftUI

/// Settings → AI providers: which services power the assistant, and which of
/// their models it uses. The same server actions back the web Settings page,
/// so either surface can be used and the other shows the result.
struct AIProvidersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var mainModel = ""
    @State private var fastModel = ""
    @State private var isSaving = false
    @State private var savedNotice = false
    @State private var seeded = false

    private var settings: ModelProviderSettings? { model.modelProviders }

    var body: some View {
        Form {
            Group {
                if let settings {
                    modelsSection(settings)
                voiceSection(settings)
                    Section {
                        ForEach(settings.connections) { connection in
                            NavigationLink {
                                ModelConnectionDetailView(connectionID: connection.id)
                            } label: {
                                connectionRow(connection, settings: settings)
                            }
                        }
                        NavigationLink {
                            ConnectProviderView()
                        } label: {
                            Label("Connect a provider", systemImage: "plus.circle")
                        }
                    } header: {
                        Text("Providers")
                    } footer: {
                        Text("API keys are encrypted on your server and never sent back to this phone.")
                    }
                } else {
                    Section { ProgressView() }
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("AI providers")
        .assistantSubmenuChrome()
        .task {
            await model.refreshModelProviders()
            // Seed once. Coming back from a model list re-runs this task, and
            // reseeding then would throw away the choice just made.
            guard !seeded, let settings else { return }
            mainModel = settings.mainModel ?? ""
            fastModel = settings.fastModel ?? ""
            seeded = true
        }
        .refreshable { await model.refreshModelProviders() }
        // A save (here or on the web) moves the server value: follow it.
        .onChange(of: settings?.mainModel) { _, value in mainModel = value ?? "" }
        .onChange(of: settings?.fastModel) { _, value in fastModel = value ?? "" }
    }

    private func modelsSection(_ settings: ModelProviderSettings) -> some View {
        Section {
            modelPicker("Main model", selection: $mainModel, settings: settings)
            modelPicker("Fast model", selection: $fastModel, settings: settings)
            Button {
                isSaving = true
                Task {
                    savedNotice = await model.chooseTextModels(main: mainModel, fast: fastModel)
                    isSaving = false
                }
            } label: {
                HStack {
                    Text(isSaving ? "Saving…" : "Use these models")
                    Spacer()
                    if isSaving { ProgressView() }
                    else if savedNotice { Image(systemName: "checkmark").foregroundStyle(.green) }
                }
            }
            .disabled(
                isSaving || mainModel.isEmpty || fastModel.isEmpty
                    || (mainModel == settings.mainModel && fastModel == settings.fastModel)
            )
        } header: {
            Text("Models")
        } footer: {
            Text("The main model plans, uses tools and writes your replies. The fast model sorts, extracts and rewrites in the background.")
        }
    }

    private func voiceSection(_ settings: ModelProviderSettings) -> some View {
        let chosen = settings.models.first { $0.id == settings.voiceModel }
        let presets = settings.voicePresets ?? []
        return Section {
            if !settings.voiceGroups.isEmpty {
                NavigationLink {
                    ModelChoiceList(
                        title: "Voice model",
                        groups: settings.voiceGroups,
                        selection: Binding(
                            get: { settings.voiceModel ?? "" },
                            set: { id in Task { _ = await model.chooseVoiceModel(id) } }
                        )
                    )
                } label: {
                    LabeledContent("Voice model", value: chosen?.label ?? "Choose")
                }
            }
            ForEach(presets) { preset in
                Button {
                    Task { _ = await model.addVoicePreset(connectionId: preset.connectionId, model: preset.model) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Add \(preset.label)", systemImage: "plus.circle")
                        Text(preset.note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if settings.voiceGroups.isEmpty && presets.isEmpty {
                Text("Connect OpenAI or Google Vertex AI to add a voice model.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Voice model (phone calls)")
        } footer: {
            Text("The live speech model that holds phone conversations for you, billed per audio token by its provider.")
        }
    }

    private func modelPicker(
        _ title: String,
        selection: Binding<String>,
        settings: ModelProviderSettings
    ) -> some View {
        let chosen = settings.models.first { $0.id == selection.wrappedValue }
        return NavigationLink {
            ModelChoiceList(title: title, groups: settings.choosableGroups, selection: selection)
        } label: {
            LabeledContent(title, value: chosen?.label ?? (selection.wrappedValue.isEmpty ? "Choose" : selection.wrappedValue))
        }
        .onChange(of: selection.wrappedValue) { _, _ in savedNotice = false }
    }

    private func connectionRow(_ connection: ModelConnection, settings: ModelProviderSettings) -> some View {
        let count = settings.models.filter { $0.connectionId == connection.id && $0.enabled }.count
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(connection.label)
                if !connection.enabled {
                    Text("Off").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                } else if connection.lastError != nil {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .accessibilityLabel("Needs attention")
                }
            }
            Text("\(connection.kindLabel) · \(count) \(count == 1 ? "model" : "models")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// Pick one chat model, grouped under the provider that serves it.
private struct ModelChoiceList: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let groups: [(connection: ModelConnection, models: [CatalogModel])]
    @Binding var selection: String

    var body: some View {
        Form {
            Group {
                ForEach(groups, id: \.connection.id) { group in
                    Section(group.connection.label) {
                        ForEach(group.models) { catalogModel in
                            Button {
                                selection = catalogModel.id
                                dismiss()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(catalogModel.label)
                                        Text(catalogModel.priceLabel)
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if catalogModel.id == selection {
                                        Image(systemName: "checkmark")
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(.tint)
                                            .accessibilityLabel("Selected")
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(title)
        .assistantSubmenuChrome()
    }
}

/// One connection: its status, its models, and the controls that change it.
private struct ModelConnectionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    let connectionID: String

    @State private var listing: [ProviderModelListing]?
    @State private var isTesting = false
    @State private var isWorking = false
    @State private var newModel = ""
    @State private var inputPrice = ""
    @State private var outputPrice = ""

    private var connection: ModelConnection? {
        model.modelProviders?.connections.first { $0.id == connectionID }
    }

    private var models: [CatalogModel] {
        model.modelProviders?.models.filter { $0.connectionId == connectionID } ?? []
    }

    var body: some View {
        Form {
            Group {
                if let connection {
                    Section {
                        LabeledContent("Type", value: connection.kindLabel)
                        if let url = connection.baseUrl { LabeledContent("Base URL", value: url) }
                        LabeledContent(
                            "Credentials",
                            value: connection.source == "environment"
                                ? "Set up with this deployment"
                                : connection.kind == "vertex"
                                    ? "Server’s Google credentials"
                                    : connection.hasApiKey ? "API key saved" : "No API key"
                        )
                        if let error = connection.lastError {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                        }
                        Button {
                            isTesting = true
                            Task {
                                listing = await model.testModelProvider(id: connectionID)
                                isTesting = false
                            }
                        } label: {
                            HStack {
                                Text(isTesting ? "Testing…" : "Test connection")
                                Spacer()
                                if isTesting { ProgressView() }
                            }
                        }
                        .disabled(isTesting)
                    }

                    Section("Models") {
                        if models.isEmpty {
                            Text("No models yet.").foregroundStyle(.secondary)
                        }
                        ForEach(models) { catalogModel in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(catalogModel.label)
                                Text(catalogModel.priceLabel)
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    addModelSection

                    Section {
                        Button(connection.enabled ? "Turn off" : "Turn on") {
                            run { await model.setModelProviderEnabled(id: connectionID, enabled: !connection.enabled) }
                        }
                        if connection.source == "saved" {
                            Button("Remove connection", role: .destructive) {
                                run {
                                    let removed = await model.removeModelProvider(id: connectionID)
                                    if removed { dismiss() }
                                    return removed
                                }
                            }
                        }
                    }
                    .disabled(isWorking)
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle(connection?.label ?? "Provider")
        .assistantSubmenuChrome()
    }

    private var addModelSection: some View {
        Section {
            TextField("Model name", text: $newModel)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onChange(of: newModel) { _, value in
                    guard let match = listing?.first(where: { $0.model == value }) else { return }
                    if let price = match.promptCostPerMTok { inputPrice = price }
                    if let price = match.completionCostPerMTok { outputPrice = price }
                }
            if let listing, !listing.isEmpty {
                let matches = listing.filter {
                    newModel.isEmpty || $0.model.localizedCaseInsensitiveContains(newModel)
                }
                ForEach(matches.prefix(6)) { entry in
                    Button(entry.model) { newModel = entry.model }
                        .font(.callout.monospaced())
                }
            }
            TextField("$ per million input tokens", text: $inputPrice)
                .keyboardType(.decimalPad)
            TextField("$ per million output tokens", text: $outputPrice)
                .keyboardType(.decimalPad)
            Button("Add model") {
                let chosen = listing?.first { $0.model == newModel }
                run {
                    let added = await model.addProviderModel(
                        connectionId: connectionID,
                        model: newModel,
                        label: chosen?.label,
                        inputPrice: inputPrice,
                        outputPrice: outputPrice,
                        thinking: chosen?.thinking
                    )
                    if added {
                        newModel = ""
                        inputPrice = ""
                        outputPrice = ""
                    }
                    return added
                }
            }
            .disabled(isWorking || newModel.isEmpty || inputPrice.isEmpty || outputPrice.isEmpty)
        } header: {
            Text("Add a model")
        } footer: {
            Text("Prices keep your spending caps accurate; a model without them can’t be used. Test the connection to pick from its models.")
        }
    }

    private func run(_ work: @escaping () async -> Bool) {
        isWorking = true
        Task {
            _ = await work()
            isWorking = false
        }
    }
}

/// Connect OpenAI, OpenRouter, Vertex, or any OpenAI-compatible gateway.
private struct ConnectProviderView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "openai"
    @State private var gatewayID = ""
    @State private var label = ""
    @State private var apiKey = ""
    @State private var baseUrl = ""
    @State private var project = ""
    @State private var location = ""
    @State private var isSaving = false
    @State private var testError: String?

    var body: some View {
        Form {
            Group {
                Section {
                    Picker("Provider", selection: $kind) {
                        ForEach(ModelConnection.kinds, id: \.self) { value in
                            Text(ModelConnection.kindLabel(value)).tag(value)
                        }
                    }
                    TextField("Name (optional)", text: $label)
                }
                if kind == "openai_compatible" {
                    Section {
                        TextField("Short id, e.g. groq", text: $gatewayID)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Base URL", text: $baseUrl)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                if kind == "vertex" {
                    Section {
                        TextField("Google Cloud project (optional)", text: $project)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("Location, e.g. us-central1", text: $location)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } footer: {
                        Text("Vertex uses your server’s own Google Cloud credentials, so there’s no key to paste.")
                    }
                } else {
                    Section {
                        SecureField("API key", text: $apiKey)
                            .textContentType(.password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } footer: {
                        Text("Stored encrypted on your server and never shown again.")
                    }
                }
                if let testError {
                    Section {
                        Label("Saved, but the test failed: \(testError)", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
            }
            .listRowBackground(AssistantTheme.raised(for: colorScheme))
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("Connect a provider")
        .assistantSubmenuChrome()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Connecting…" : "Connect", action: connect)
                    .disabled(isSaving || (kind == "openai_compatible" && (gatewayID.isEmpty || baseUrl.isEmpty)))
            }
        }
    }

    private func connect() {
        isSaving = true
        testError = nil
        let input = ModelConnectionInput(
            kind: kind,
            id: kind == "openai_compatible" ? gatewayID : nil,
            label: label.isEmpty ? nil : label,
            apiKey: apiKey.isEmpty ? nil : apiKey,
            baseUrl: kind == "openai_compatible" ? baseUrl : nil,
            vertexProject: kind == "vertex" && !project.isEmpty ? project : nil,
            vertexLocation: kind == "vertex" && !location.isEmpty ? location : nil
        )
        Task {
            let result = await model.connectModelProvider(input)
            isSaving = false
            apiKey = ""
            guard let result else { return }
            if let error = result.testError { testError = error } else { dismiss() }
        }
    }
}
