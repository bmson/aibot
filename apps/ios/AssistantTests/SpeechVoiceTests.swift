import AVFoundation
import XCTest
@testable import Assistant

/// How the assistant sounds, decided without an audio stack.
///
/// None of this can be tested by listening on CI — the simulator has no neural
/// voices at all — so the parts that decide *which* voice and *how* a passage
/// reaches the synthesizer are pure, and this is where they are held to it.
final class SpeechVoiceTests: XCTestCase {

    // MARK: - Choosing a voice

    func testNeuralVoicesWinOverTheCompactOne() {
        let best = SpeechVoices.best(
            in: [compact("Samantha"), enhanced("Ava"), premium("Zoe")],
            language: "en-US"
        )
        XCTAssertEqual(best?.name, "Zoe")
    }

    func testEnhancedIsTakenWhenNoPremiumIsInstalled() {
        let best = SpeechVoices.best(in: [compact("Samantha"), enhanced("Ava")], language: "en-US")
        XCTAssertEqual(best?.name, "Ava")
    }

    /// The trap this whole ranking exists to avoid. Siri's voices are listed on
    /// the device and report themselves as premium, but a third-party utterance
    /// given one is spoken in the compact default instead — so an app that went
    /// looking for a good voice ends up sounding worse than one that did not.
    func testSiriVoicesAreNeverChosenEvenThoughTheyLookBest() {
        let siri = SpeechVoices.Candidate(
            identifier: "com.apple.ttsbundle.siri_Nicky_en-US_premium",
            name: "Nicky",
            language: "en-US",
            quality: .premium
        )
        let best = SpeechVoices.best(in: [siri, enhanced("Ava")], language: "en-US")
        XCTAssertEqual(best?.name, "Ava")
        XCTAssertFalse(SpeechVoices.isUsable(siri))
    }

    /// Eloquence is a speech aid — speed over naturalness, for people who read
    /// by ear all day. Never a chat reply.
    func testSpeechAidsAndNoveltyVoicesAreLeftOut() {
        let eloquence = SpeechVoices.Candidate(
            identifier: "com.apple.eloquence.en-US.Grandma",
            name: "Grandma",
            language: "en-US",
            quality: .default
        )
        let novelty = SpeechVoices.Candidate(
            identifier: "com.apple.speech.synthesis.voice.Bubbles",
            name: "Bubbles",
            language: "en-US",
            quality: .default
        )
        XCTAssertFalse(SpeechVoices.isUsable(eloquence))
        XCTAssertFalse(SpeechVoices.isUsable(novelty))
        XCTAssertNil(SpeechVoices.best(in: [eloquence, novelty], language: "en-US"))
    }

    func testTheOwnersLanguageBeatsAHigherTierInAnother() {
        let best = SpeechVoices.best(
            in: [premium("Zoe", language: "en-US"), enhanced("Daniel", language: "en-GB")],
            language: "en-GB"
        )
        XCTAssertEqual(best?.name, "Daniel")
    }

    /// A phone set to en-AU with no Australian voice installed should still be
    /// spoken to in English rather than dropped to the system fallback.
    func testARegionalVariantIsBetterThanNothing() {
        let best = SpeechVoices.best(in: [premium("Zoe", language: "en-US")], language: "en-AU")
        XCTAssertEqual(best?.name, "Zoe")
    }

    /// Two premium voices are both good. The one already chosen in Settings is
    /// the one the owner meant.
    func testTheSystemVoiceBreaksATieBetweenEquals() {
        let ava = premium("Ava")
        let zoe = premium("Zoe")
        XCTAssertEqual(SpeechVoices.best(in: [ava, zoe], language: "en-US", systemDefault: zoe.identifier)?.name, "Zoe")
        XCTAssertEqual(SpeechVoices.best(in: [ava, zoe], language: "en-US", systemDefault: ava.identifier)?.name, "Ava")
    }

    /// Otherwise the pick must not depend on the order the system enumerated
    /// in: an assistant that changes voice between launches reads as a bug.
    func testTheOrderVoicesArriveInDoesNotChangeTheAnswer() {
        let voices = [premium("Zoe"), premium("Ava"), enhanced("Nicky")]
        let best = SpeechVoices.best(in: voices, language: "en-US")?.identifier
        XCTAssertEqual(SpeechVoices.best(in: voices.reversed(), language: "en-US")?.identifier, best)
    }

    func testNothingInstalledIsAnAnswerRatherThanACrash() {
        XCTAssertNil(SpeechVoices.best(in: [], language: "en-US"))
    }

    // MARK: - Cadence

    /// A bare fragment gets no sentence-final fall from the synthesizer: the
    /// pitch stays level and every list item lands on the same note.
    func testFragmentsAreGivenAFullStop() {
        XCTAssertEqual(SpeechProsody.phrase(from: "Call the studio"), "Call the studio.")
        XCTAssertEqual(SpeechProsody.phrase(from: "Tomorrow"), "Tomorrow.")
    }

    func testSentencesAreLeftExactlyAsWritten() {
        XCTAssertEqual(SpeechProsody.phrase(from: "Both are free."), "Both are free.")
        XCTAssertEqual(SpeechProsody.phrase(from: "Want me to hold it?"), "Want me to hold it?")
        XCTAssertEqual(SpeechProsody.phrase(from: "Careful!"), "Careful!")
    }

    /// A colon leans into what follows. Closing it off would be the wrong shape
    /// for "Run this:" and the code block being announced after it.
    func testAnIntroducingColonKeepsItsLift() {
        XCTAssertEqual(SpeechProsody.phrase(from: "Run this:"), "Run this:")
    }

    func testPunctuationInsideAClosingQuoteStillCounts() {
        XCTAssertEqual(SpeechProsody.phrase(from: "She said “no.”"), "She said “no.”")
        XCTAssertEqual(SpeechProsody.phrase(from: "(and it is booked)"), "(and it is booked).")
    }

    func testNothingToSayIsNotAnUtterance() {
        XCTAssertNil(SpeechProsody.phrase(from: "   \n "))
        XCTAssertEqual(SpeechProsody.phrase(from: "  Done  "), "Done.")
    }

    // MARK: - Pace

    /// The complaint this setting answers: the system's read-aloud rate is a
    /// dictation pace, and the assistant is talking, not reading a document.
    func testTheDefaultPaceIsFasterThanTheSystemReadAloudRate() {
        XCTAssertEqual(SpeechPace.default, .brisk)
        XCTAssertGreaterThan(SpeechPace.default.rate, AVSpeechUtteranceDefaultSpeechRate)
        XCTAssertEqual(SpeechPace.steady.rate, AVSpeechUtteranceDefaultSpeechRate, accuracy: 0.0001)
    }

    func testEveryPaceIsSpeakableAndOrdered() {
        for pace in SpeechPace.allCases {
            XCTAssertGreaterThanOrEqual(pace.rate, AVSpeechUtteranceMinimumSpeechRate)
            XCTAssertLessThanOrEqual(pace.rate, AVSpeechUtteranceMaximumSpeechRate)
        }
        let rates = SpeechPace.allCases.map(\.rate)
        XCTAssertEqual(rates, rates.sorted())
    }

    func testAnUnknownStoredPaceFallsBackRatherThanGoingSilent() {
        XCTAssertNil(SpeechPace(rawValue: "glacial"))
        XCTAssertEqual(SpeechPace(rawValue: "quick"), .quick)
    }

    // MARK: - Fixtures

    private func premium(_ name: String, language: String = "en-US") -> SpeechVoices.Candidate {
        SpeechVoices.Candidate(
            identifier: "com.apple.voice.premium.\(language).\(name)",
            name: name,
            language: language,
            quality: .premium
        )
    }

    private func enhanced(_ name: String, language: String = "en-US") -> SpeechVoices.Candidate {
        SpeechVoices.Candidate(
            identifier: "com.apple.voice.enhanced.\(language).\(name)",
            name: name,
            language: language,
            quality: .enhanced
        )
    }

    private func compact(_ name: String, language: String = "en-US") -> SpeechVoices.Candidate {
        SpeechVoices.Candidate(
            identifier: "com.apple.voice.compact.\(language).\(name)",
            name: name,
            language: language,
            quality: .default
        )
    }
}
