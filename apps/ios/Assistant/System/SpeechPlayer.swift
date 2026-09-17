import AVFoundation
import Foundation

/// The assistant's voice, on the phone and nowhere else.
///
/// `AVSpeechSynthesizer` runs entirely on device: no key, no quota, no network,
/// and nothing about a reply leaves the phone in order to be said out loud. For
/// an assistant whose whole claim is that the owner holds their own data, that
/// is not a compromise — it is the version that matches the product.
///
/// Passages are enqueued rather than played one at a time. The synthesizer owns
/// the queue, so a reply can be spoken as it streams in: each finished block
/// joins the end of the line and the speech never stops between them.
@MainActor
final class SpeechPlayer: ObservableObject {
    static let shared = SpeechPlayer()

    /// The message being read, if any. Nil the instant the queue drains.
    @Published private(set) var speakingMessageID: String?

    private let synthesizer = AVSpeechSynthesizer()
    private let observer = SpeechQueueObserver()
    private var sessionIsActive = false

    private init() {
        synthesizer.delegate = observer
        observer.onQueueDrained = { [weak self] in
            Task { @MainActor [weak self] in self?.queueDidDrain() }
        }
    }

    var isSpeaking: Bool { speakingMessageID != nil }

    func isSpeaking(_ messageID: String) -> Bool { speakingMessageID == messageID }

    /// Read this message from the top, whatever was being said before.
    func speak(_ passages: [String], for messageID: String) {
        stop()
        enqueue(passages, for: messageID)
    }

    /// Add to what is already being said. Used by the streaming path, where
    /// each finished block of a reply arrives while the one before it is still
    /// being read.
    func enqueue(_ passages: [String], for messageID: String) {
        let utterances = passages.compactMap(SpeechPlayer.utterance(for:))
        guard !utterances.isEmpty else { return }
        activateSession()
        speakingMessageID = messageID
        for utterance in utterances { synthesizer.speak(utterance) }
    }

    func stop() {
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
        speakingMessageID = nil
        deactivateSession()
    }

    /// Stop only if this particular message is the one being read — used where
    /// a row is hidden or replaced and its speech has outlived it.
    func stop(messageID: String) {
        guard speakingMessageID == messageID else { return }
        stop()
    }

    private func queueDidDrain() {
        speakingMessageID = nil
        deactivateSession()
    }

    // MARK: - Utterances

    private static func utterance(for passage: String) -> AVSpeechUtterance? {
        let text = passage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = SpeechVoices.preferred
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        // A block boundary is a beat in the writing. Give it one in the reading
        // too, so two paragraphs do not run together into a single breath.
        utterance.preUtteranceDelay = 0.12
        return utterance
    }

    // MARK: - Audio session

    /// `.spokenAudio` with `.duckOthers` is the read-aloud contract: music drops
    /// under the assistant's voice and comes back up, rather than stopping.
    ///
    /// This category also ignores the ring/silent switch, which is right for a
    /// deliberate "read this to me" and wrong for anything the owner did not
    /// ask for — which is why speaking replies automatically is opt-in and says
    /// so where it is turned on.
    private func activateSession() {
        guard !sessionIsActive else { return }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            sessionIsActive = true
        } catch {
            // A session this app could not claim is a silent reply, not a
            // broken one. Speaking is never the point of the turn.
        }
    }

    private func deactivateSession() {
        guard sessionIsActive else { return }
        sessionIsActive = false
        // Other audio only resumes on a deactivation that says so.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

/// Which installed voice the assistant speaks with.
///
/// The tiers matter more than anything else about how this feature is received.
/// `.default` voices are compressed and audibly mechanical; `.enhanced` and
/// `.premium` are neural and genuinely good. An app cannot download the good
/// ones — the owner fetches them in Settings › Accessibility › Spoken Content ›
/// Voices — and Siri's own voices are not available to third-party apps at all.
/// So: take the best of what is installed, and say once, where the setting
/// lives, that better ones exist.
enum SpeechVoices {
    static var preferred: AVSpeechSynthesisVoice? {
        best(in: AVSpeechSynthesisVoice.speechVoices(), language: AVSpeechSynthesisVoice.currentLanguageCode())
            ?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
    }

    /// Whether the best installed voice for this language is one of the neural
    /// ones. False means the owner is hearing the compact voice, and the hint
    /// in Settings is worth showing.
    static var hasNaturalVoice: Bool {
        guard let voice = preferred else { return false }
        return voice.quality != .default
    }

    static var preferredVoiceName: String? { preferred?.name }

    /// Pure, so the ranking can be reasoned about without an audio stack.
    static func best(in voices: [AVSpeechSynthesisVoice], language: String) -> AVSpeechSynthesisVoice? {
        let matching = voices.filter { $0.language == language }
        let candidates = matching.isEmpty
            ? voices.filter { $0.language.hasPrefix(String(language.prefix(2))) }
            : matching
        return candidates
            .filter { !isSpeechAid($0) }
            .max { rank($0) < rank($1) }
    }

    private static func rank(_ voice: AVSpeechSynthesisVoice) -> Int {
        switch voice.quality {
        case .premium: 3
        case .enhanced: 2
        default: 1
        }
    }

    /// Eloquence voices ship for people who read by ear all day and want speed
    /// over naturalness. They share the `.default` tier with the ordinary
    /// compact voices, and picking one for a chat reply is never the intent.
    private static func isSpeechAid(_ voice: AVSpeechSynthesisVoice) -> Bool {
        voice.identifier.localizedCaseInsensitiveContains("eloquence")
    }
}

/// `AVSpeechSynthesizerDelegate` makes no promise about which queue it calls
/// back on, so the delegate is its own object and hops to the main actor rather
/// than making `SpeechPlayer` pretend to be reachable from anywhere.
private final class SpeechQueueObserver: NSObject, AVSpeechSynthesizerDelegate {
    var onQueueDrained: (@Sendable () -> Void)?

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        // More passages may already be queued behind this one; the reply is
        // only over when nothing is left to say.
        guard !synthesizer.isSpeaking else { return }
        onQueueDrained?()
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        onQueueDrained?()
    }
}

/// Where the speech preferences live. Read from `AppModel` as well as the
/// settings screen, so the key is defined once.
enum SpeechSettings {
    static let speakRepliesKey = "speech.speakRepliesAloud"

    static var speakRepliesAloud: Bool {
        UserDefaults.standard.bool(forKey: speakRepliesKey)
    }
}
