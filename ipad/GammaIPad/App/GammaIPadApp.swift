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
    @State private var showServerSignIn = false
    @State private var webSafelyPausedForNative = false
    @StateObject private var pdfViewport = GammaPDFViewportController()
    @StateObject private var webCommands = GammaWebCommandController()
    @State private var switchingMode = false
    @State private var showDisconnectConfirmation = false
    @State private var disconnectRecovery: Data?
    @State private var disconnectWarning = ""
    @State private var returnRequest: GammaWebOpenRequest?
    @State private var showEmbeddedRecovery = false
    @State private var embeddedRecovery: Data?
    @State private var embeddedRecoveryWarning = ""

    var body: some View {
        Group {
            if !sessionBootstrapFinished || (workspace.restoringSession && workspace.username == nil && !workspace.isLocal) {
                ProgressView("Opening Gamma…")
            } else if workspace.username == nil && !workspace.isLocal { signIn }
            else {
                ZStack {
                    if let session = workspace.webSession {
                        GammaWebWorkspace(serverURL: session.serverURL, workspace: session.workspace,
                            cookies: session.cookies,
                            sessionID: session.id, reloadToken: webReloadToken, commandController: webCommands,
                             localServerAccess: session.localServerAccess,
                            onOpenPDF: { request, cookies in
                                Task {
                                    if await workspace.openFromWeb(request, cookies: cookies) {
                                        nativeViewport = request.viewport
                                        nativeViewportPageID = request.pageID
                                        webSafelyPausedForNative = true
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
                                if !workspace.isLocal || workspace.isEmbeddedLocal {
                                    Button { Task { await returnToFullGamma() } }
                                        label: { Label("Full Gamma", systemImage: "chevron.left") }
                                    .font(.caption).disabled(switchingMode || workspace.busy || workspace.syncing || workspace.isOffline || workspace.nativeWriteInProgress || workspace.hasFailedNativeSave)
                                }
                                GammaWorkspaceMenu(workspace: workspace)
                                libraryModeMenu
                                Spacer()
                                if workspace.isLocal {
                                    Label("On this iPad", systemImage: "ipad")
                                        .font(.caption2).foregroundStyle(.secondary)
                                } else if workspace.requiresLogin {
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
                                     initialViewport: nativeViewportPageID == paper.id ? nativeViewport : nil,
                                     viewportController: pdfViewport)
                                     .id(paper.id)
                            } else { library }
                        }
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if useWeb, workspace.webSession != nil {
                        HStack { libraryModeMenu; Spacer(); Button { showDownloads = true } label: {
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
                            if returnRequest != nil {
                                Button("Retry position") { Task { await retryWebPosition() } }
                                    .font(.caption).disabled(switchingMode)
                            }
                            Button("Dismiss") { workspace.errorMessage = nil; returnRequest = nil }.font(.caption)
                        }.padding(12).background(.regularMaterial)
                    }
                }
            }
        }
        .tint(GammaTheme.accent)
        .overlay {
            if switchingMode {
                ProgressView("Switching workspace…")
                    .padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.primary.opacity(0.05)).contentShape(Rectangle())
            }
        }
        .alert("Disconnect from server?", isPresented: $showDisconnectConfirmation) {
            Button("Stay connected", role: .cancel) {
                disconnectRecovery = nil
                Task { await webCommands.cancelDisconnect() }
            }
            Button(disconnectRecovery == nil ? "Disconnect anyway" : "Save recovery and disconnect", role: .destructive) {
                Task { await finishDisconnect(recovery: disconnectRecovery) }
            }
        } message: { Text(disconnectWarning) }
        .alert("Recover local Gamma?", isPresented: $showEmbeddedRecovery) {
            Button("Cancel", role: .cancel) {
                embeddedRecovery = nil
                Task { await webCommands.cancelDisconnect() }
            }
            Button("Recover local Gamma", role: .destructive) {
                Task { await finishEmbeddedRecovery() }
            }
        } message: { Text(embeddedRecoveryWarning) }
        .sheet(isPresented: $showDownloads) { GammaDownloadsView(workspace: workspace) }
        .sheet(isPresented: $showServerSignIn, onDismiss: {
            if workspace.isEmbeddedLocal { Task { await webCommands.cancelDisconnect() } }
        }) {
            NavigationStack {
                signIn.navigationTitle("Connect a server")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showServerSignIn = false }.disabled(workspace.busy)
                        }
                    }
            }.interactiveDismissDisabled(workspace.busy)
        }
        .task {
            workspace.reloadOfflineAccounts()
            await workspace.restoreInitialLibrary()
            if workspace.isLocal { useWeb = workspace.isEmbeddedLocal && workspace.webSession != nil }
            sessionBootstrapFinished = true
        }
        .onChange(of: workspace.isLocal) { _, local in
            if local { useWeb = workspace.isEmbeddedLocal && workspace.webSession != nil }
            else if workspace.username != nil { showServerSignIn = false }
        }
        .onChange(of: workspace.webSession?.id) { _, id in
            webSafelyPausedForNative = false
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
                #if GAMMA_EMBEDDED_BACKEND
                if workspace.isEmbeddedLocal {
                    Task { await workspace.embeddedDidBecomeActive() }
                } else {
                    workspace.sessionDidBecomeActive()
                    Task { await workspace.sync() }
                }
                #else
                workspace.sessionDidBecomeActive()
                Task { await workspace.sync() }
                #endif
            } else if phase == .background {
                #if GAMMA_EMBEDDED_BACKEND
                if workspace.isEmbeddedLocal { workspace.embeddedDidEnterBackground() }
                else { workspace.sessionDidEnterBackground() }
                #else
                workspace.sessionDidEnterBackground()
                #endif
            }
        }
    }
    private func returnToFullGamma() async {
        guard !switchingMode else { return }
        var request: GammaWebOpenRequest?
        if let paper = workspace.paper, let document = workspace.document,
           let docID = paper.properties.docID, let user = workspace.username {
            guard let viewport = pdfViewport.capture(document: document) else {
                workspace.errorMessage = "The PDF position is not ready yet. Please try returning again."
                return
            }
            request = GammaWebOpenRequest(pageID: paper.id, docID: docID, title: paper.content,
                user: user, workspace: workspace.workspaceID, viewport: viewport)
        }
        switchingMode = true
        defer { switchingMode = false }
        guard await workspace.prepareWebWorkspace() else { return }
        webSafelyPausedForNative = false
        useWeb = true
        returnRequest = request
        if let request, let session = workspace.webSession {
            let restored = await webCommands.restorePosition(request: request, serverURL: session.serverURL, reload: true)
            if restored { returnRequest = nil }
            else { workspace.errorMessage = webCommands.lastFailure ?? "The Web reader could not restore the current PDF position." }
        } else { webReloadToken = UUID() }
    }

    private func retryWebPosition() async {
        guard !switchingMode, let request = returnRequest, let session = workspace.webSession else { return }
        switchingMode = true
        defer { switchingMode = false }
        if await webCommands.restorePosition(request: request, serverURL: session.serverURL) {
            returnRequest = nil; workspace.errorMessage = nil
        } else { workspace.errorMessage = webCommands.lastFailure ?? "Position restore failed." }
    }

    private func beginEmbeddedRecovery() async {
        #if GAMMA_EMBEDDED_BACKEND
        guard workspace.isEmbeddedLocal, !switchingMode else { return }
        switchingMode = true
        defer { switchingMode = false }
        let result = await webCommands.prepareDisconnect()
        embeddedRecovery = result.recovery
        embeddedRecoveryWarning = "Saved local PDFs, notes and recordings will be kept. The local Web workspace will reopen."
        if !result.ok {
            embeddedRecoveryWarning += result.recoveryComplete
                ? " Unsent Web changes will first be saved as a recovery copy, not silently applied."
                : " The Web workspace could not fully preserve its unsaved changes; those changes may be lost. Cancel if you need to copy them first."
        }
        showEmbeddedRecovery = true
        #endif
    }

    private func finishEmbeddedRecovery() async {
        #if GAMMA_EMBEDDED_BACKEND
        guard !switchingMode, workspace.isEmbeddedLocal else { return }
        switchingMode = true
        defer { switchingMode = false; embeddedRecovery = nil }
        do {
            if let data = embeddedRecovery { try workspace.persistWebDisconnectRecovery(data) }
            webCommands.detach()
            if await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true, restartRunning: true) {
                useWeb = workspace.paper == nil
                webSafelyPausedForNative = false
            }
        } catch {
            workspace.errorMessage = error.localizedDescription
            await webCommands.cancelDisconnect()
        }
        #endif
    }

    private func beginConnectServer() async {
        guard !switchingMode, workspace.canChangeLibrary else { return }
        switchingMode = true
        defer { switchingMode = false }
        if workspace.isEmbeddedLocal, workspace.webSession != nil, !webSafelyPausedForNative {
            let result = await webCommands.prepareDisconnect()
            guard result.ok else {
                await webCommands.cancelDisconnect()
                workspace.errorMessage = "Local Gamma still has unsaved edits. Save or retry them before connecting a different server."
                return
            }
        }
        if !(await workspace.resumeServerLibrary()) { showServerSignIn = true }
    }

    private func beginDisconnect() async {
        guard !switchingMode, workspace.canDisconnectServer else { return }
        switchingMode = true
        disconnectRecovery = nil
        if workspace.webSession != nil && !webSafelyPausedForNative {
            let result = await webCommands.prepareDisconnect()
            if !result.ok {
                disconnectRecovery = result.recovery
                disconnectWarning = result.recovery == nil
                    ? "The Web workspace could not confirm that all edits are saved. Disconnecting may discard unsaved Web edits. Saved native files and pending native changes will stay on this iPad."
                    : "Some Web edits could not reach the server. A recovery copy will be saved on this iPad before disconnecting; it is not a successful server sync. Native files and pending changes will also be kept."
                if let recovery = result.recovery {
                    let object = (try? JSONSerialization.jsonObject(with: recovery)) as? [String: Any]
                    if object?["complete"] as? Bool != true {
                        disconnectWarning += " The recovery copy may be incomplete; some unsaved Web edits may still be lost."
                    }
                }
                if let reason = result.reason { disconnectWarning += "\n\n" + reason }
                switchingMode = false
                showDisconnectConfirmation = true
                return
            }
        }
        switchingMode = false
        await finishDisconnect(recovery: nil)
    }

    private func finishDisconnect(recovery: Data?) async {
        guard !switchingMode else { return }
        switchingMode = true
        defer { switchingMode = false; disconnectRecovery = nil }
        if await workspace.disconnectServerToLocal(recovery: recovery) {
            webCommands.detach()
            useWeb = false; webSafelyPausedForNative = false
            nativeViewport = nil; nativeViewportPageID = nil; returnRequest = nil
            showServerSignIn = false; showDownloads = false
        } else { await webCommands.cancelDisconnect() }
    }

    private var libraryModeMenu: some View {
        Menu {
            if workspace.isLocal {
                Button("Connect a Gamma server…") {
                    Task { await beginConnectServer() }
                }
                if workspace.isEmbeddedLocal {
                    Button("Recover local Gamma…") { Task { await beginEmbeddedRecovery() } }
                }
            } else {
                Button {
                    Task { await beginDisconnect() }
                } label: { Label("Disconnect server · On this iPad", systemImage: "ipad") }
            }
        } label: {
            Label(workspace.isLocal ? "Server" : "Disconnect", systemImage: "network").font(.caption)
        }
        .accessibilityLabel("Choose local or server library")
        .accessibilityIdentifier("library-mode-menu")
        .disabled(switchingMode || (workspace.isLocal ? !workspace.canChangeLibrary : !workspace.canDisconnectServer))
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
            if !workspace.isLocal {
                Button {
                    Task { await beginDisconnect() }
                } label: { Label("Use on this iPad — no account needed", systemImage: "ipad") }
                    .buttonStyle(.bordered).disabled(workspace.busy || workspace.syncing)
                    .accessibilityIdentifier("use-local-library")
            }
            VStack(spacing: 14) {
                TextField("Server · https://gamma.example.com", text: $server)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Username", text: $username)
                    .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password", text: $password).textContentType(.password)
                Button {
                    let secret = password; password = ""
                    Task {
                        await workspace.login(server: server, username: username, password: secret)
                        if !workspace.isLocal, workspace.username != nil { showServerSignIn = false }
                    }
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
    private var library: some View {
        GammaLibraryView(workspace: workspace)
            .id(workspace.isLocal ? "local-library" : "server:\(workspace.accountServer):\(workspace.username ?? ""):\(workspace.workspaceID)")
    }
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
