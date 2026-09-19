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
    @State private var showDownloads = false
    @State private var nativeViewport: GammaReadingPosition?
    @State private var nativeViewportPageID: String?
    @State private var sessionBootstrapFinished = false

    var body: some View {
        Group {
            if (!sessionBootstrapFinished || workspace.restoringSession) && workspace.username == nil {
                ProgressView("Opening Gamma…")
            } else if workspace.username == nil { signIn }
            else {
                ZStack {
                    if let session = workspace.webSession {
                        GammaWebWorkspace(serverURL: session.serverURL, workspace: session.workspace,
                            cookies: session.cookies,
                            sessionID: session.id, reloadToken: webReloadToken,
                            onOpenPDF: { request, cookies in
                                Task {
                                    if await workspace.openFromWeb(request, cookies: cookies) {
                                        nativeViewport = request.viewport
                                        nativeViewportPageID = request.pageID
                                        useWeb = false
                                    }
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
                                GammaWorkspaceMenu(workspace: workspace)
                                Spacer()
                                if workspace.requiresLogin {
                                    GammaReconnectButton(workspace: workspace)
                                } else if workspace.isOffline {
                                    Label("Offline · reconnecting", systemImage: "wifi.slash")
                                        .font(.caption2).foregroundStyle(.secondary)
                                } else if workspace.paper == nil {
                                    Text("Library").font(.caption2).foregroundStyle(.secondary)
                                }
                            }.padding(.horizontal, 14).frame(height: 34).background(GammaTheme.surface)
                            if let paper = workspace.paper, let document = workspace.document {
                                GammaReaderView(workspace: workspace, paper: paper, document: document,
                                     initialViewport: nativeViewportPageID == paper.id ? nativeViewport : nil)
                                     .id(paper.id)
                            } else { library }
                        }
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if useWeb, workspace.webSession != nil {
                        HStack { Spacer(); Button { showDownloads = true } label: {
                            Label("Downloads", systemImage: "arrow.down.circle")
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
        .sheet(isPresented: $showDownloads) { GammaDownloadsView(workspace: workspace) }
        .task {
            workspace.reloadOfflineAccounts()
            await workspace.restoreSession()
            sessionBootstrapFinished = true
        }
        .onChange(of: workspace.webSession?.id) { _, id in
            if id != nil, workspace.paper == nil, !workspace.isOffline { useWeb = true }
        }
        .onChange(of: workspace.isOffline) { _, offline in
            if offline { useWeb = false }
            else if workspace.paper == nil, workspace.webSession != nil { useWeb = true }
        }
        .onChange(of: workspace.requiresLogin) { _, required in
            if required { useWeb = false }
        }
        .task(id: workspace.username) {
            guard workspace.username != nil else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                await workspace.sync()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                workspace.sessionDidBecomeActive()
                Task { await workspace.sync() }
            } else if phase == .background {
                workspace.sessionDidEnterBackground()
            }
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
                    Text("Each entry is one Gamma library. No connection needed; sign in to the same account later to sync edits.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(workspace.offlineAccounts) { account in
                        Button {
                            workspace.enterOffline(account); useWeb = false
                        } label: {
                            VStack(alignment: .leading) {
                                Label(account.displayName, systemImage: account.isLegacy ? "questionmark.folder" : "ipad")
                                Text(account.isLegacy
                                     ? "Saved before Gamma libraries existed — sign in online once to attach it. \(account.server)"
                                     : account.server)
                                    .font(.caption2).lineLimit(3)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.bordered).disabled(workspace.busy)
                            .accessibilityIdentifier(account.isLegacy ? "offline-account-legacy" : "offline-account")
                    }
                }
            }
            if let error = workspace.errorMessage { Text(error).font(.caption).foregroundStyle(.red) }
            Text("Connect to your Gamma server. Your session is saved securely on this iPad. Your password is not stored.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer(); Spacer()
        }.frame(maxWidth: 380).padding(28).frame(maxWidth: .infinity)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(GammaTheme.canvas)
    }
    private var library: some View { GammaLibraryView(workspace: workspace) }
}

/// The library in use, and — when the account may write in more than one — an
/// explicit switch. Switching is refused while anything is queued, because a
/// queued change belongs to the workspace it was written in.
struct GammaWorkspaceMenu: View {
    @ObservedObject var workspace: GammaWorkspace

    var body: some View {
        if workspace.writableWorkspaces.count > 1 {
            Menu {
                Section("Gamma workspace") {
                    ForEach(workspace.writableWorkspaces) { option in
                        Button {
                            Task { await workspace.switchWorkspace(to: option.id) }
                        } label: {
                            if option.id == workspace.workspaceID { Label(option.name, systemImage: "checkmark") }
                            else { Text(option.name) }
                        }
                    }
                }
                if !workspace.canSwitchWorkspace {
                    Text("Sync pending changes before switching workspaces")
                }
            } label: {
                Label(workspace.workspaceDisplayName, systemImage: "books.vertical")
                    .font(.caption).lineLimit(1)
            }
            .disabled(!workspace.canSwitchWorkspace)
            .accessibilityIdentifier("workspace-menu")
        } else {
            Label(workspace.workspaceDisplayName, systemImage: "books.vertical")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                .accessibilityIdentifier("workspace-label")
        }
    }
}

enum GammaTheme {
    static let accent = Color(red: 0.24, green: 0.43, blue: 0.68)
    static let canvas = Color(uiColor: .systemGroupedBackground)
    static let surface = Color(uiColor: .systemBackground)
    static let notes = Color(uiColor: .secondarySystemBackground)
    static let line = Color.primary.opacity(0.09)
}
