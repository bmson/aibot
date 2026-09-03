import XCTest
@testable import Assistant

/// Stands in for the network so a dead pooled connection can be reproduced
/// deterministically. Each queued outcome is consumed by one request, so a test
/// says exactly what the first attempt and the retry each see.
final class StubURLProtocol: URLProtocol {
    enum Outcome {
        case failure(URLError)
        case success(status: Int, body: Data)
    }

    private static let lock = NSLock()
    private static var outcomes: [Outcome] = []
    private static var recordedMethods: [String] = []

    static func prime(_ queued: [Outcome]) {
        lock.withLock {
            outcomes = queued
            recordedMethods = []
        }
    }

    /// One entry per attempt that reached the network — the assertion that
    /// distinguishes "retried once" from "never retried" and from "retried".
    static var attempts: [String] {
        lock.withLock { recordedMethods }
    }

    private static func next(for method: String) -> Outcome {
        lock.withLock {
            recordedMethods.append(method)
            return outcomes.isEmpty ? .success(status: 200, body: Data()) : outcomes.removeFirst()
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        switch Self.next(for: method) {
        case let .failure(error):
            client?.urlProtocol(self, didFailWithError: error)
        case let .success(status, body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

final class APIClientRetryTests: XCTestCase {
    private func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            configuration: .init(baseURL: URL(string: "https://assistant.test")!, token: "t"),
            session: URLSession(configuration: configuration)
        )
    }

    /// The failure this whole change exists for: the first attempt is handed a
    /// connection that died during suspension, and the second one succeeds.
    func testReadRetriesOnceAfterATimeout() async throws {
        let body = Data(#"{"findings":[]}"#.utf8)
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .success(status: 200, body: body),
        ])

        let cleanup = try await makeClient().knowledgeCleanup()

        XCTAssertEqual(cleanup.findings.count, 0)
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
    }

    /// A retry that fails too reports the transport error, not Foundation's.
    func testRepeatedTimeoutSurfacesTransportCopy() async {
        StubURLProtocol.prime([
            .failure(URLError(.timedOut)),
            .failure(URLError(.timedOut)),
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected the second timeout to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
            XCTAssertEqual(
                error.errorDescription,
                "Couldn't reach your assistant — it may still be waking up."
            )
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET", "GET"])
    }

    /// Writes are never replayed: the server may well have applied the first
    /// one before its answer went missing, and a doubled decision is worse
    /// than a visible failure.
    func testWriteIsNotRetried() async {
        StubURLProtocol.prime([.failure(URLError(.timedOut))])

        do {
            _ = try await makeClient().decideApproval(id: "a1", decision: "approved")
            XCTFail("expected the timeout to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["POST"])
    }

    /// Only failures a fresh connection could plausibly fix are retried.
    func testUnrecoverableTransportFailureIsNotRetried() async {
        StubURLProtocol.prime([.failure(URLError(.userAuthenticationRequired))])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected the error to propagate")
        } catch let error as APIError {
            XCTAssertTrue(error.isTransport)
        } catch {
            XCTFail("expected APIError.transport, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    /// A server that answered is not a transport failure, so the banner must
    /// not offer to retry it — the same answer would come back.
    func testServerErrorIsNotTreatedAsTransport() async {
        StubURLProtocol.prime([
            .success(status: 500, body: Data(#"{"error":"boom"}"#.utf8)),
        ])

        do {
            _ = try await makeClient().knowledgeCleanup()
            XCTFail("expected a server error")
        } catch let error as APIError {
            XCTAssertFalse(error.isTransport)
            XCTAssertEqual(error.errorDescription, "boom")
        } catch {
            XCTFail("expected APIError.server, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.attempts, ["GET"])
    }

    func testOfflineGetsItsOwnCopy() {
        let error = APIError.transport(URLError(.notConnectedToInternet))
        XCTAssertEqual(error.errorDescription, "You appear to be offline.")
    }
}
