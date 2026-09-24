import Foundation
import Combine

/// In-memory credentials only. Never encode, persist, log, or inject into JavaScript.
struct GammaEmbeddedCookie: CustomStringConvertible, CustomReflectable {
    let name: String
    let value: String
    let domain = "127.0.0.1"
    let path = "/"
    let httpOnly = true
    let hostOnly = true
    let secure = false
    let sameSite = "Strict"
    var description: String { "<private embedded cookie>" }
    var customMirror: Mirror { Mirror(self, children: [:]) }

    fileprivate init(_ raw: Any?) throws {
        guard let fields = raw as? [String: Any],
              let name = fields["name"] as? String, !name.isEmpty,
              name.utf8.allSatisfy({ (33...126).contains($0) && !"()<>@,;:\\\"/[]?={} ".utf8.contains($0) }),
              let value = fields["value"] as? String, !value.isEmpty,
              value.utf8.allSatisfy({ (33...126).contains($0) && !"\";,\\".utf8.contains($0) }),
              fields["domain"] as? String == "127.0.0.1",
              fields["path"] as? String == "/",
              fields["http_only"] as? Bool == true,
              fields["host_only"] as? Bool == true,
              fields["secure"] as? Bool == false,
              fields["same_site"] as? String == "Strict" else {
            throw GammaEmbeddedRuntimeFailure.invalidBootstrap
        }
        self.name = name
        self.value = value
    }

    /// Host-only Set-Cookie (no Domain attribute). Use only in an ephemeral store.
    func httpCookie(origin: URL) throws -> HTTPCookie {
        guard origin.scheme == "http", origin.host == domain,
              let port = origin.port, (1024...65535).contains(port),
              origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil else {
            throw GammaEmbeddedRuntimeFailure.invalidBootstrap
        }
        let fields = ["Set-Cookie": "\(name)=\(value); Path=/; HttpOnly; SameSite=Strict"]
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: fields, for: origin).first,
              cookie.domain == domain, cookie.isHTTPOnly, !cookie.isSecure,
              cookie.expiresDate == nil else {
            throw GammaEmbeddedRuntimeFailure.invalidBootstrap
        }
        return cookie
    }
}

struct GammaEmbeddedBootstrap: CustomStringConvertible, CustomReflectable {
    let url: URL
    let account: String
    let workspace: String
    let sessionCookie: GammaEmbeddedCookie
    let capabilityCookie: GammaEmbeddedCookie
    let capabilityHeader: String
    var capability: String { capabilityCookie.value }
    var description: String { "<private embedded bootstrap>" }
    var customMirror: Mirror { Mirror(self, children: [:]) }

    init(json: Data) throws {
        guard json.count <= 65536,
              let fields = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let rawURL = fields["url"] as? String,
              let parts = URLComponents(string: rawURL),
              parts.scheme == "http", parts.host == "127.0.0.1",
              let port = parts.port, (1024...65535).contains(port),
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              let url = parts.url,
              let account = fields["account"] as? String, !account.isEmpty,
              let workspace = fields["workspace"] as? String, !workspace.isEmpty,
              fields["capability_header"] as? String == "X-Gamma-Local-Capability" else {
            throw GammaEmbeddedRuntimeFailure.invalidBootstrap
        }
        self.url = url
        self.account = account
        self.workspace = workspace
        sessionCookie = try GammaEmbeddedCookie(fields["session_cookie"])
        capabilityCookie = try GammaEmbeddedCookie(fields["capability_cookie"])
        guard sessionCookie.name != capabilityCookie.name,
              capabilityCookie.value.count >= 32 else {
            throw GammaEmbeddedRuntimeFailure.invalidBootstrap
        }
        capabilityHeader = "X-Gamma-Local-Capability"
    }

    /// Both origin AND port must match; loopback cookies alone have no port scope.
    func permits(_ candidate: URL) -> Bool {
        candidate.scheme == url.scheme && candidate.host == url.host &&
        candidate.port == url.port && candidate.user == nil && candidate.password == nil
    }
}

enum GammaEmbeddedRuntimeFailure: LocalizedError {
    case invalidBootstrap, unavailable
    var errorDescription: String? {
        switch self {
        case .invalidBootstrap: return "The embedded backend returned an invalid bootstrap."
        case .unavailable: return "The embedded backend is not available in its current state."
        }
    }
}

/// One process owner. Scene backgrounding retains this interpreter and server;
/// iOS suspends their execution with the process. `stop()` is for explicit engine
/// teardown, never brief backgrounding. Do not terminate or duplicate CPython.
@MainActor
final class GammaEmbeddedRuntimeController: ObservableObject {
    static let shared = GammaEmbeddedRuntimeController()
    enum State: Equatable {
        case stopped, starting, running, stopping, failed(String)
    }
    @Published private(set) var state: State = .stopped
    private(set) var bootstrap: GammaEmbeddedBootstrap?
    private let runtime = GammaEmbeddedRuntime.shared()
    private var generation: UInt64 = 0
    private var activeDataRoot: URL?
    private init() {
        runtime.didExitHandler = { [weak self] _ in
            // The native API guarantees main-queue delivery before its stop completions.
            guard let self else { return }
            self.bootstrap = nil
            if self.state == .running || self.state == .starting {
                self.state = .failed("Embedded backend exited.")
            } else if self.state == .stopping {
                self.state = .stopped
            }
        }
    }

    func start(dataRoot: URL) async throws -> GammaEmbeddedBootstrap {
        try Task.checkCancellation()
        let requestedRoot = dataRoot.standardizedFileURL.resolvingSymlinksInPath()
        if let activeDataRoot, activeDataRoot != requestedRoot {
            throw GammaEmbeddedRuntimeFailure.unavailable
        }
        // Multiple native surfaces can ask for the one local engine while the
        // app's initial bootstrap is still running. Join that startup instead
        // of spawning a second interpreter or reporting a spurious failure.
        if state == .starting {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(45))
            while state == .starting && clock.now < deadline {
                try await Task.sleep(for: .milliseconds(40))
            }
            try Task.checkCancellation()
            // Joiners observe this attempt's result; a failed attempt must not
            // spawn one new engine attempt per waiting surface.
            guard state == .running, let bootstrap else {
                throw GammaEmbeddedRuntimeFailure.unavailable
            }
            return bootstrap
        }
        if state == .running, let bootstrap { return bootstrap }
        switch state {
        case .stopped, .failed: break
        default: throw GammaEmbeddedRuntimeFailure.unavailable
        }
        activeDataRoot = requestedRoot
        generation &+= 1
        let current = generation
        state = .starting
        do {
            let data: Data = try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    runtime.start(dataRoot: dataRoot) { data, error in
                        if let error { continuation.resume(throwing: error) }
                        else if let data { continuation.resume(returning: data) }
                        else { continuation.resume(throwing: GammaEmbeddedRuntimeFailure.invalidBootstrap) }
                    }
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    guard let self, self.generation == current else { return }
                    await self.stop()
                }
            }
            guard generation == current, state == .starting else { throw CancellationError() }
            try Task.checkCancellation()
            let result: GammaEmbeddedBootstrap
            do { result = try GammaEmbeddedBootstrap(json: data) }
            catch { await stop(); throw GammaEmbeddedRuntimeFailure.invalidBootstrap }
            bootstrap = result
            state = .running
            return result
        } catch {
            if generation == current {
                bootstrap = nil
                state = .failed("Embedded backend startup failed.")
            }
            throw error
        }
    }

    /// Returns within the native bound. `.stopping` after return means shutdown
    /// timed out; retry stop later. Never start another interpreter to recover.
    func stop() async {
        generation &+= 1
        let current = generation
        bootstrap = nil
        state = .stopping
        let error: Error? = await withCheckedContinuation { continuation in
            runtime.stop { error in continuation.resume(returning: error) }
        }
        guard generation == current else { return }
        if let error = error as NSError? {
            state = error.code == 4 ? .stopping : .failed("Embedded backend shutdown failed.")
        } else { state = .stopped }
    }
}
