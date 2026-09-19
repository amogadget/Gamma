import XCTest
import PencilKit
@testable import GammaIPad

/// Opt-in local preparation tool. Input is copied into the simulator's private
/// Documents/GammaReplayPreparation directory; no accounts/passwords are used.
final class GammaReplayPreparationTests: XCTestCase {
    @MainActor
    func testPrepareRequestedSources() throws {
        struct Entry: Decodable { let name: String; let width: Double; let height: Double }
        struct Input: Decodable { let entries: [Entry] }
        let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("GammaReplayPreparation", isDirectory: true)
        let inputURL = root.appendingPathComponent("input.json")
        guard FileManager.default.fileExists(atPath: inputURL.path) else { throw XCTSkip("No explicit replay preparation input") }
        let input = try JSONDecoder().decode(Input.self, from: Data(contentsOf: inputURL))
        XCTAssertLessThanOrEqual(input.entries.count, 100)
        for entry in input.entries {
            guard Int(entry.name) != nil, entry.name.count <= 6 else { throw CocoaError(.fileReadInvalidFileName) }
            let source = try Data(contentsOf: root.appendingPathComponent(entry.name + ".pkdrawing"))
            let drawing = try PKDrawing(data: source)
            let preview = try GammaWebInkExport.encode(drawing: drawing, sourceData: source,
                pageSize: CGSize(width: entry.width, height: entry.height))
            try preview.write(to: root.appendingPathComponent(entry.name + ".inkjson"), options: .atomic)
        }
    }
}
