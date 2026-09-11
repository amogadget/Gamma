import SwiftUI

/// A visible action wherever the local workspace asks the user to sign in.
struct GammaReconnectButton: View {
    @ObservedObject var workspace: GammaWorkspace
    @State private var showingSignIn = false

    var body: some View {
        Button { showingSignIn = true } label: {
            Label("Sign in to sync", systemImage: "person.crop.circle.badge.checkmark")
        }
        .buttonStyle(.borderedProminent).controlSize(.small)
        .accessibilityIdentifier("offline-sign-in")
        .disabled(workspace.busy || workspace.syncing)
        .sheet(isPresented: $showingSignIn) { GammaReconnectView(workspace: workspace) }
    }
}

struct GammaReconnectView: View {
    @ObservedObject var workspace: GammaWorkspace
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var submitting = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Current account") {
                    Text(workspace.username ?? "")
                    Text(workspace.accountServer).font(.caption).textSelection(.enabled)
                }
                Section {
                    SecureField("Password", text: $password)
                        .textContentType(.password).accessibilityIdentifier("reconnect-password")
                        .onSubmit { signIn() }
                    Button(action: signIn) {
                        HStack {
                            if submitting { ProgressView() }
                            Text(submitting ? "Signing in…" : "Sign in and sync")
                        }
                    }.disabled(password.isEmpty || submitting)
                        .accessibilityIdentifier("reconnect-submit")
                } footer: {
                    Text("Your files stay on this iPad. Sign in to this account to send pending edits and download missing files.")
                }
                if let failure { Section { Text(failure).foregroundStyle(.red) } }
            }
            .navigationTitle("Sign in to sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(submitting)
                }
            }
            .interactiveDismissDisabled(submitting)
        }
    }
    private func signIn() {
        guard !password.isEmpty, !submitting, let user = workspace.username else { return }
        let secret = password; password = ""; submitting = true; failure = nil
        Task {
            await workspace.login(server: workspace.accountServer, username: user, password: secret, reconnect: true)
            submitting = false
            if !workspace.isOffline { dismiss() }
            else { failure = workspace.errorMessage ?? "Could not sign in. Your local files are still available." }
        }
    }
}
