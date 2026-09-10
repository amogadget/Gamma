import SwiftUI

@main
struct GammaIPadApp: App {
    @StateObject private var workspace = GammaWorkspace()
    var body: some Scene {
        WindowGroup { GammaRootView(workspace: workspace) }
    }
}

struct GammaRootView: View {
    @ObservedObject var workspace: GammaWorkspace
    @Environment(\.scenePhase) private var scenePhase
    @State private var server = UserDefaults.standard.string(forKey: "gamma.server") ?? ""
    @State private var username = UserDefaults.standard.string(forKey: "gamma.username") ?? ""
    @State private var password = ""

    var body: some View {
        Group {
            if workspace.username == nil { signIn }
            else if let paper = workspace.paper, let document = workspace.document {
                GammaReaderView(workspace: workspace, paper: paper, document: document)
            } else { library }
        }
        .tint(GammaTheme.accent)
        .task(id: workspace.username) {
            guard workspace.username != nil else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                await workspace.sync()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await workspace.sync() } }
        }
    }
    private var signIn: some View {
        VStack(spacing: 24) {
            Spacer()
            VStack(spacing: 8) {
                Image("GammaMark").resizable().scaledToFit().frame(width: 84, height: 84)
                    .accessibilityLabel("Gamma")
                Text("Gamma").font(.system(size: 26, weight: .semibold))
                Text("Your library. Your notes.").foregroundStyle(.secondary).font(.subheadline)
            }
            VStack(spacing: 14) {
                TextField("Server · https://gamma.example.com", text: $server)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Username", text: $username)
                    .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password", text: $password).textContentType(.password)
                Button {
                    let secret = password; password = ""
                    Task { await workspace.login(server: server, username: username, password: secret) }
                } label: {
                    HStack { Spacer(); if workspace.busy { ProgressView() }; Text("Sign in"); Spacer() }
                        .padding(.vertical, 6)
                }.buttonStyle(.borderedProminent).disabled(workspace.busy || username.isEmpty || password.isEmpty)
            }.textFieldStyle(.roundedBorder).padding(24).background(GammaTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            if let error = workspace.errorMessage { Text(error).font(.caption).foregroundStyle(.red) }
            Text("Connect to your Gamma server. Credentials stay on this device only for the current session.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer(); Spacer()
        }.frame(maxWidth: 380).padding(28).frame(maxWidth: .infinity, maxHeight: .infinity).background(GammaTheme.canvas)
    }
    private var library: some View { GammaLibraryView(workspace: workspace) }
}

enum GammaTheme {
    static let accent = Color(red: 0.24, green: 0.43, blue: 0.68)
    static let canvas = Color(uiColor: .systemGroupedBackground)
    static let surface = Color(uiColor: .systemBackground)
    static let notes = Color(uiColor: .secondarySystemBackground)
    static let line = Color.primary.opacity(0.09)
}
