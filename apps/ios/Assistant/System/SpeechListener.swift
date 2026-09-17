import AVFoundation
import Foundation
import Speech

/// Talking to the assistant instead of typing at it.
///
/// On-device transcription through the Speech framework's `SpeechAnalyzer`: the
/// audio never leaves the phone, there is no per-minute ceiling on how long a
/// thought may be, and punctuation arrives with the words. The app already
/// targets iOS 26 everywhere, so this is reachable without a fallback path to
/// keep alive beside it.
///
/// What it deliberately does not do is send. A transcription is a draft in the
/// composer for the owner to glance at and correct — misheard words are
/// ordinary, and this assistant acts on what it is told.
@MainActor
final class SpeechListener: ObservableObject {

    enum State: Equatable {
        case idle
        /// First use in a language downloads its model, once, system-wide.
        case preparing
        case listening
        /// Microphone refused, language unsupported, or the model would not
        /// install. Carries something worth showing the owner.
        case unavailable(String)
    }

    @Published private(set) var state: State = .idle

    /// Everything heard so far: the settled words plus the tail still firming
    /// up. Written straight into the composer as it changes.
    @Published private(set) var transcript = ""

    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var settled = ""
    private var volatileTail = ""

    var isListening: Bool { state == .listening }

    // MARK: - Listening

    func start() async {
        guard state != .listening, state != .preparing else { return }
        // Half duplex, on purpose: a phone listening to its own voice
        // transcribes it. Barge-in needs the echo cancellation that talk mode
        // turns on; push-to-talk simply takes turns.
        SpeechPlayer.shared.stop()

        settled = ""
        volatileTail = ""
        transcript = ""
        state = .preparing

        guard await AVAudioApplication.requestRecordPermission() else {
            state = .unavailable("Microphone access is off for Assistant. Settings › Assistant › Microphone.")
            return
        }

        do {
            let transcriber = try await makeTranscriber()
            self.transcriber = transcriber

            let analyzer = SpeechAnalyzer(modules: [transcriber])
            self.analyzer = analyzer

            guard let format = await SpeechTranscriber.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                state = .unavailable("This iPhone has no audio format the transcriber can take.")
                return
            }

            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            input = continuation
            try await analyzer.start(inputSequence: stream)

            results = Task { [weak self] in await self?.consume(transcriber) }
            try startEngine(writingTo: continuation, format: format)
            state = .listening
        } catch {
            await teardown()
            state = .unavailable(error.localizedDescription)
        }
    }

    /// Stop listening and hand back everything that was heard.
    @discardableResult
    func stop() async -> String {
        guard state == .listening || state == .preparing else { return transcript }
        await teardown()
        state = .idle
        return transcript
    }

    func reset() {
        transcript = ""
        settled = ""
        volatileTail = ""
        if case .unavailable = state { state = .idle }
    }

    // MARK: - Pieces

    private func makeTranscriber() async throws -> SpeechTranscriber {
        let locale = Locale.current
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            // The tail of a sentence is shown as it firms up, the way a person
            // watching themselves be understood expects.
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )

        // The language model is a system asset, downloaded once and shared by
        // every app on the phone. It is a first-class state rather than an
        // error: the first sentence in a new language waits for it.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        return transcriber
    }

    private func consume(_ transcriber: SpeechTranscriber) async {
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if result.isFinal {
                    settled = join(settled, text)
                    volatileTail = ""
                } else {
                    volatileTail = text
                }
                transcript = join(settled, volatileTail)
            }
        } catch {
            // A stream that ends badly still leaves the owner whatever was
            // already understood, in the composer, to send or to throw away.
            state = .unavailable(error.localizedDescription)
        }
    }

    private func startEngine(
        writingTo continuation: AsyncStream<AnalyzerInput>.Continuation,
        format: AVAudioFormat
    ) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let node = engine.inputNode
        let inputFormat = node.outputFormat(forBus: 0)
        let converter = AudioFormatConverter(from: inputFormat, to: format)

        // This closure runs on the audio render thread. It touches nothing but
        // its own converter and the stream's continuation, both of which are
        // safe to call from there.
        node.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
            guard let converted = converter.convert(buffer) else { return }
            continuation.yield(AnalyzerInput(buffer: converted))
        }

        engine.prepare()
        try engine.start()
    }

    private func teardown() async {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        input?.finish()
        input = nil

        // Finalising flushes whatever was said last through the model, so the
        // final words of a sentence are not lost with the button release.
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        results?.cancel()
        results = nil
        analyzer = nil
        transcriber = nil

        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    private func join(_ lead: String, _ tail: String) -> String {
        let lead = lead.trimmingCharacters(in: .whitespaces)
        let tail = tail.trimmingCharacters(in: .whitespaces)
        if lead.isEmpty { return tail }
        if tail.isEmpty { return lead }
        return "\(lead) \(tail)"
    }
}

/// Sample-rate and channel conversion between the microphone's format and the
/// one the transcriber asked for.
///
/// Its own type, and deliberately not main-actor isolated: it is called from
/// the audio render thread on every buffer, where hopping actors is exactly
/// what must not happen.
private final class AudioFormatConverter {
    private let converter: AVAudioConverter?
    private let target: AVAudioFormat
    private let source: AVAudioFormat

    init(from source: AVAudioFormat, to target: AVAudioFormat) {
        self.source = source
        self.target = target
        converter = source == target ? nil : AVAudioConverter(from: source, to: target)
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }

        let ratio = target.sampleRate / source.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }

        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }

        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }
}
