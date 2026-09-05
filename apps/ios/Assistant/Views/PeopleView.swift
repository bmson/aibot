import SwiftUI

/// The People directory.
///
/// Everything on screen arrives already worded by `/api/mobile/v1/people`:
/// "18 March · turns 40 in 7 months", "Last contact today", "10 years". The
/// rules behind those — when a birth year may become an age, when a start date
/// is precise enough to become a duration — are decided once in the
/// application layer, so this screen and the web read identically and cannot
/// drift apart. Nothing here formats a date or infers a fact.
struct PeopleView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var query = ""

    /// Birthdays inside this window get their own section at the top.
    private let comingUpWindowDays = 30

    private var matches: [PersonSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return model.people }
        return model.people.filter { person in
            person.name.lowercased().contains(needle)
                || person.relationship.lowercased().contains(needle)
                || (person.location?.lowercased().contains(needle) ?? false)
        }
    }

    /// Family, Work, Friends, then everyone not yet placed. The order is fixed
    /// rather than alphabetical so the list does not reshuffle as people move
    /// between buckets.
    private var groups: [PersonGroupSection] {
        let order = ["family", "work", "friends", "other"]
        return order.compactMap { key in
            let people = matches.filter { $0.group == key }
            guard !people.isEmpty else { return nil }
            // "Other" is a gap in what we know, not a group someone belongs to,
            // so the server sends no label for it and the heading says so.
            let label = people.first?.groupLabel ?? ""
            return PersonGroupSection(
                label: label.isEmpty ? "Not placed yet" : label,
                people: people
            )
        }
    }

    private var comingUp: [PersonSummary] {
        model.people
            .filter { ($0.birthdayDaysUntil ?? .max) <= comingUpWindowDays }
            .sorted { ($0.birthdayDaysUntil ?? .max) < ($1.birthdayDaysUntil ?? .max) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !model.peopleLoaded {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 220)
                } else if model.people.isEmpty {
                    emptyDirectory
                } else {
                    content
                }
            }
            .padding(16)
            .padding(.bottom, 28)
            .frame(maxWidth: isLandscape ? 760 : .infinity, alignment: .leading)
        }
        .navigationTitle("People")
        .assistantSubmenuChrome()
        .searchable(text: $query, prompt: "Name, relationship, or place")
        .contentMargins(.bottom, 72, for: .scrollContent)
        .refreshable { await model.loadPeople() }
        .task { if !model.peopleLoaded { await model.loadPeople() } }
    }

    @ViewBuilder
    private var content: some View {
        // Birthdays are the one time-sensitive thing here, so they lead.
        if !comingUp.isEmpty && query.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeading("Coming up", count: comingUp.count)
                ForEach(comingUp) { person in
                    NavigationLink(value: AssistantDestination.person(id: person.id)) {
                        comingUpRow(person)
                    }
                    .buttonStyle(.plain)
                }
            }
        }

        if matches.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Nobody matches “\(query)”.").font(.headline)
                Text("Try a name, a relationship, or a place.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantPanel(in: colorScheme)
        }

        ForEach(groups) { group in
            VStack(alignment: .leading, spacing: 10) {
                sectionHeading(group.label, count: group.people.count)
                ForEach(group.people) { person in
                    NavigationLink(value: AssistantDestination.person(id: person.id)) {
                        personRow(person)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var emptyDirectory: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No people yet").font(.headline)
            Text(
                "Names mentioned in conversations become contacts automatically, "
                    + "or add someone from Memory."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantPanel(in: colorScheme)
    }

    private func comingUpRow(_ person: PersonSummary) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "calendar")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name).font(.subheadline.weight(.semibold))
                if let birthday = person.birthday {
                    Text(birthday).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .assistantCard(
            in: colorScheme,
            surface: AssistantTheme.accent(for: colorScheme).opacity(0.07),
            strokeTint: AssistantTheme.accent(for: colorScheme).opacity(0.28)
        )
    }

    private func personRow(_ person: PersonSummary) -> some View {
        HStack(spacing: 12) {
            PersonInitialsBadge(initials: person.initials, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(person.name).font(.headline)
                    if person.trust == "unknown" {
                        Text("Unverified")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 5)
                            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                    }
                }
                // Each line is dropped when its source is empty, so a person
                // the assistant barely knows shows a name and nothing invented.
                Text(person.relationship.isEmpty ? "Relationship not set" : person.relationship)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let detail = secondaryLine(person) {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .assistantCard(in: colorScheme)
    }

    /// Location, last contact, and birthday joined into one quiet line.
    private func secondaryLine(_ person: PersonSummary) -> String? {
        let parts = [person.location, person.lastContact, person.birthday].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.headline)
            if let count {
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }
        }
    }

    private var isLandscape: Bool { verticalSizeClass == .compact }
}

/// One heading in the directory. A named type rather than a tuple so `ForEach`
/// has a stable `Identifiable` conformance to key rows off.
private struct PersonGroupSection: Identifiable {
    let label: String
    let people: [PersonSummary]
    var id: String { label }
}

/// An initials disc. There is no photograph anywhere in the data model, so
/// this is an identity marker rather than a placeholder for a missing image.
struct PersonInitialsBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let initials: String
    var size: CGFloat = 40

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.34, weight: .medium, design: .rounded))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .background(AssistantTheme.sunken(for: colorScheme), in: Circle())
            .accessibilityHidden(true)
    }
}

/// One person, in full.
///
/// Section order matches the web card: who they are, birthday and how you met,
/// their connections, what happened recently. Every section is omitted when
/// its source is empty rather than rendering a "not recorded" row, so a person
/// with nothing but a name shows a short honest card instead of a form.
struct PersonCardScreen: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.colorScheme) private var colorScheme
    let personId: String

    private var card: PersonCard? { model.personCards[personId] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let card {
                    cardContent(card)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 220)
                }
            }
            .padding(16)
            .padding(.bottom, 28)
        }
        .navigationTitle(card?.name ?? "Person")
        .navigationBarTitleDisplayMode(.inline)
        .assistantSubmenuChrome()
        .refreshable { await model.loadPersonCard(id: personId) }
        .task { if card == nil { await model.loadPersonCard(id: personId) } }
    }

    @ViewBuilder
    private func cardContent(_ card: PersonCard) -> some View {
        identity(card)

        if card.birthday != nil || !card.howWeMet.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                if let birthday = card.birthday {
                    detailRow(icon: "gift", label: "Birthday", value: birthday)
                }
                if !card.howWeMet.isEmpty {
                    detailRow(
                        icon: "hand.wave",
                        label: "How you met",
                        value: card.howWeMet.joined(separator: "\n")
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantPanel(in: colorScheme)
        }

        VStack(alignment: .leading, spacing: 10) {
            sectionHeading("Relationships", count: card.relations.count)
            if card.relations.isEmpty {
                emptyNote(
                    "No connections to other people are recorded yet. They are extracted "
                        + "from what you tell the assistant."
                )
            } else {
                ForEach(card.relations) { relation in
                    if let otherId = relation.otherContactId {
                        NavigationLink(value: AssistantDestination.person(id: otherId)) {
                            relationRow(relation, linked: true)
                        }
                        .buttonStyle(.plain)
                    } else {
                        // Someone named only inside a fact has no page to open.
                        relationRow(relation, linked: false)
                    }
                }
            }
        }

        if !card.connections.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeading("Also connected", count: card.connections.count)
                ForEach(card.connections) { connection in
                    HStack(alignment: .top, spacing: 10) {
                        Text(connection.sentence).font(.subheadline)
                        Spacer(minLength: 8)
                        if !connection.span.isEmpty {
                            Text(connection.span).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .assistantCard(in: colorScheme)
                }
            }
        }

        VStack(alignment: .leading, spacing: 10) {
            sectionHeading("Recently", count: card.events.count)
            if card.events.isEmpty {
                emptyNote("Nothing has been recorded about time spent with \(card.name).")
            } else {
                ForEach(card.events) { event in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "sparkles")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AssistantTheme.accent(for: colorScheme))
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(event.content)
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(
                                event.dateIsRecordTime
                                    ? "\(event.date) · as recorded"
                                    : event.date
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .assistantCard(in: colorScheme)
                }
                Text("What happened is kept for 90 days; lasting details are saved as facts.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }

        // Only ever backed by a real occasion inside its own lead window —
        // the same one that reaches the morning brief.
        if let reminder = card.reminder {
            VStack(alignment: .leading, spacing: 4) {
                Text(reminder.headline).font(.subheadline.weight(.semibold))
                Text(reminder.detail).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantCard(
                in: colorScheme,
                surface: AssistantTheme.accent(for: colorScheme).opacity(0.07),
                strokeTint: AssistantTheme.accent(for: colorScheme).opacity(0.28)
            )
        }

        // Editing lives in Memory, which already owns the person controls.
        Text("\(card.factCount) saved \(card.factCount == 1 ? "fact" : "facts") · manage in Memory")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func identity(_ card: PersonCard) -> some View {
        HStack(alignment: .top, spacing: 14) {
            PersonInitialsBadge(initials: card.initials, size: 56)
            VStack(alignment: .leading, spacing: 5) {
                Text(card.name).font(.title3.weight(.semibold))
                Text(identityLine(card)).font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    if !card.groupLabel.isEmpty {
                        Text(card.groupLabel)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 6)
                            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                    }
                    if card.trust == "unknown" {
                        Text("Unverified")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 6)
                            .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .assistantCard(in: colorScheme)
    }

    private func identityLine(_ card: PersonCard) -> String {
        let parts = [
            card.relationship.isEmpty ? "Relationship not set" : card.relationship,
            card.location,
            card.lastContact,
        ].compactMap { $0 }
        return parts.joined(separator: " · ")
    }

    private func relationRow(_ relation: PersonRelationSummary, linked: Bool) -> some View {
        HStack(spacing: 10) {
            PersonInitialsBadge(initials: relation.otherInitials, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(relation.sentence)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if relation.unreviewed {
                    Text("Not yet confirmed").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if !relation.span.isEmpty {
                Text(relation.span).font(.caption).foregroundStyle(.secondary)
            }
            if linked {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .assistantCard(in: colorScheme)
    }

    private func detailRow(icon: String, label: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(label.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    private func emptyNote(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .assistantPanel(in: colorScheme)
    }

    private func sectionHeading(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 7) {
            Text(title).font(.headline)
            if let count {
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(AssistantTheme.sunken(for: colorScheme), in: Capsule())
            }
        }
    }
}
