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
    @State private var useWeb = true
    @State private var webReloadToken: UUID?

    var body: some View {
        Group {
            if workspace.username == nil { signIn }
            else {
                ZStack {
                    if let session = workspace.webSession {
                        GammaWebWorkspace(serverURL: session.serverURL, cookies: session.cookies,
                            sessionID: session.id, reloadToken: webReloadToken,
                            onOpenPDF: { request, cookies in
                                Task {
                                    if await workspace.openFromWeb(request, cookies: cookies) { useWeb = false }
                                    else { webReloadToken = UUID() }
                                }
                            }, onError: { workspace.errorMessage = $0 })
                            .id(session.id).opacity(useWeb ? 1 : 0).allowsHitTesting(useWeb && !workspace.busy)
                            .accessibilityHidden(!useWeb)
                    }
                    if !useWeb || workspace.webSession == nil {
                        VStack(spacing: 0) {
                            HStack {
                                Button { Task {
                                    if await workspace.prepareWebWorkspace() { webReloadToken = UUID(); useWeb = true }
                                } } label: { Label("Full Gamma", systemImage: "chevron.left") }
                                .font(.caption).disabled(workspace.busy || workspace.syncing || workspace.isOffline)
                                Spacer()
                                if workspace.isOffline {
                                    GammaReconnectButton(workspace: workspace)
                                } else {
                                    Text("Pencil · Recording · Replay").font(.caption2).foregroundStyle(.secondary)
                                }
                            }.padding(.horizontal, 14).frame(height: 34).background(GammaTheme.surface)
                            if let paper = workspace.paper, let document = workspace.document {
                                GammaReaderView(workspace: workspace, paper: paper, document: document)
                            } else { library }
                        }
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if useWeb, workspace.webSession != nil {
                        HStack { Spacer(); Button { workspace.closeReader(); useWeb = false } label: {
                            Label("On this iPad", systemImage: "arrow.down.circle")
                        }.buttonStyle(.bordered).controlSize(.small)
                            .disabled(workspace.busy || workspace.syncing)
                        }.padding(.horizontal, 12).padding(.vertical, 4).background(GammaTheme.surface)
                    }
                }
                .overlay(alignment: .bottom) {
                    if useWeb, workspace.webSession != nil, let error = workspace.errorMessage {
                        HStack {
                            Text(error).font(.caption).lineLimit(3)
                            Spacer()
                            Button("Dismiss") { workspace.errorMessage = nil }.font(.caption)
                        }.padding(12).background(.regularMaterial)
                    }
                }
            }
        }
        .tint(GammaTheme.accent)
        .task { workspace.reloadOfflineAccounts() }
        .onChange(of: workspace.webSession?.id) { _, id in if id != nil { useWeb = true } }
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
        ScrollView { VStack(spacing: 24) {
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
            if !workspace.offlineAccounts.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Open files on this iPad").font(.headline)
                    Text("No connection needed. Sign in to the same account later to sync edits.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(workspace.offlineAccounts) { account in
                        Button {
                            workspace.enterOffline(account); useWeb = false
                        } label: {
                            VStack(alignment: .leading) {
                                Label(account.username, systemImage: "ipad")
                                Text(account.server).font(.caption2).lineLimit(2)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.bordered).disabled(workspace.busy)
                    }
                }
            }
            if let error = workspace.errorMessage { Text(error).font(.caption).foregroundStyle(.red) }
            Text("Connect to your Gamma server. Credentials stay on this device only for the current session.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer(); Spacer()
        }.frame(maxWidth: 380).padding(28).frame(maxWidth: .infinity)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(GammaTheme.canvas)
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
