import Foundation

struct GammaWebSession: Identifiable {
    let id: UUID
    let serverURL: URL
    let cookies: [HTTPCookie]
}
