import Foundation
import FoundationModels

/// The small, typed decision produced by Apple's on-device foundation model.
/// It decides relevance only; card facts still come from the response text and
/// are parsed by the existing deterministic card builders.
@available(iOS 26.0, *)
@Generable
struct OnDeviceCardAnalysis: Sendable {
    @Guide(description: "The user's primary intent, such as weather, directions, calendar, duration, or other")
    let primaryIntent: String

    @Guide(description: "The one eligible card kind, or none. Use weather, agenda, duration, interview-prep, or none")
    let cardKind: String

    @Guide(description: "True only when the candidate card is the primary answer requested by the user")
    let shouldRenderCard: Bool

    @Guide(.range(0.0...1.0))
    let confidence: Double
}

/// Runs the optional on-device model pass for plain-text assistant replies.
/// Explicit server data cards never enter this path.
@available(iOS 26.0, *)
enum OnDeviceCardParser {
    static func analyze(request: String, response: String) async -> OnDeviceCardAnalysis? {
        let request = request.trimmingCharacters(in: .whitespacesAndNewlines)
        let response = response.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty, !response.isEmpty else { return nil }
        guard case .available = SystemLanguageModel.default.availability else { return nil }

        let session = LanguageModelSession(instructions: """
            You classify whether an assistant response deserves a native data card.
            Identify the user's primary request first. Supporting context must not
            become a card. For example, weather mentioned inside directions is not
            a weather card unless the user explicitly asked for weather.

            Only choose weather, agenda, duration, or interview-prep when that is
            the primary answer requested by the user and the response contains the
            corresponding structured information. Interview-prep is for a research
            answer about two or more prospective interviewers, with roles and
            interview-focus notes; it is not for a single incidental biography.
            Otherwise choose cardKind none and shouldRenderCard false. Never invent
            facts, locations, or values. Confidence is between 0 and 1.
            """)

        do {
            let result = try await session.respond(generating: OnDeviceCardAnalysis.self) {
                """
                User request:
                \(request)

                Assistant response:
                \(response)

                Return a card decision. A card is eligible only when it represents
                the user's primary request, not an incidental sentence in the reply.
                """
            }
            return result.content
        } catch {
            // Model assets may still be downloading, disabled, unavailable in the
            // current locale, or temporarily busy. The caller has a safe fallback.
            return nil
        }
    }

    static func accepts(
        _ analysis: OnDeviceCardAnalysis,
        request: String,
        response: String
    ) -> Bool {
        guard analysis.shouldRenderCard, analysis.confidence >= 0.72 else { return false }
        let kind = normalizedKind(analysis.cardKind)
        guard kind != "none", requestAllows(kind: kind, request: request) else { return false }
        guard responseHasSignals(kind: kind, response: response) else { return false }

        let intent = analysis.primaryIntent.lowercased()
        switch kind {
        case "weather":
            return intent.contains("weather") || intent.contains("forecast") || intent.contains("temperature")
        case "agenda":
            return intent.contains("calendar") || intent.contains("agenda") || intent.contains("schedule")
        case "duration":
            return intent.contains("duration") || intent.contains("time") || intent.contains("estimate")
        case "interview-prep":
            return intent.contains("interview") || intent.contains("interviewer") || intent.contains("prep")
        default:
            return false
        }
    }

    static func normalizedKind(_ value: String) -> String {
        let normalized = value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        switch normalized {
        case "weather", "forecast", "temperature": return "weather"
        case "agenda", "calendar", "schedule": return "agenda"
        case "duration", "time-estimate", "time estimate": return "duration"
        case "interview-prep", "interview prep", "interviewers", "people research": return "interview-prep"
        default: return "none"
        }
    }

    static func requestAllows(kind: String, request: String) -> Bool {
        let lower = request.lowercased()
        switch kind {
        case "weather":
            return ["weather", "forecast", "temperature", "rain", "sunny", "cloudy", "snow"].contains {
                lower.contains($0)
            }
        case "agenda":
            return ["calendar", "agenda", "schedule", "events", "appointments"].contains {
                lower.contains($0)
            }
        case "duration":
            return ["how long", "duration", "take", "takes", "estimate", "minutes", "hours"].contains {
                lower.contains($0)
            }
        case "interview-prep":
            return ["interview", "interviewer", "interviewers", "prep", "prepare"].contains {
                lower.contains($0)
            }
        default:
            return false
        }
    }

    private static func responseHasSignals(kind: String, response: String) -> Bool {
        let lower = response.lowercased()
        switch kind {
        case "weather":
            return response.range(of: #"-?\d{1,3}\s*[°º]?[CF]\b"#, options: .regularExpression) != nil
                && ["weather", "forecast", "sunny", "cloudy", "rain", "snow", "wind", "humidity"].contains {
                    lower.contains($0)
                }
        case "agenda":
            return response.range(of: #"(?m)^\s*(?:[-•*]|\d+\.)?\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b"#, options: .regularExpression) != nil
        case "duration":
            return response.range(of: #"\b\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        case "interview-prep":
            let normalized = lower
                .replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "__", with: "")
            let roleCount = normalized.components(separatedBy: "role:").count - 1
            let focusCount = normalized.components(separatedBy: "interview focus:").count - 1
            return roleCount >= 2 && focusCount >= 2
        default:
            return false
        }
    }
}
