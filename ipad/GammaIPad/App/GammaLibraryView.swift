import SwiftUI

/// Gamma's web library structure: quiet toolbar, recent cards, real folders and
/// a compact file browser. No mock content or unavailable navigation controls.
struct GammaLibraryView: View {
    @ObservedObject var workspace: GammaWorkspace
    @State private var search = ""
    @State private var folder = ""
    @State private var grid = false
    @State private var alphabetical = false
    @State private var showStatus = false

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                toolbar(compact: geometry.size.width < 700)
                Rectangle().fill(GammaTheme.line).frame(height: 1)
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        if folder.isEmpty && search.isEmpty && !recent.isEmpty { recentSection }
                        if search.isEmpty && !childFolders.isEmpty { foldersSection }
                        filesSection
                    }.padding(24).frame(maxWidth: 1500, alignment: .leading).frame(maxWidth: .infinity)
                }
                .refreshable { await workspace.refreshLibrary(); await workspace.retrySync() }
                if workspace.busy {
                    HStack(spacing: 9) { ProgressView().controlSize(.small); Text("Opening document…").font(.caption); Spacer() }
                        .padding(12).background(GammaTheme.surface)
                }
            }.background(Color(uiColor: .secondarySystemBackground))
        }.tint(GammaTheme.accent)
    }
    private func toolbar(compact: Bool) -> some View {
        HStack(spacing: 12) {
            Button { folder = ""; search = "" } label: {
                Image(systemName: "house").font(.system(size: 16)).frame(width: 32, height: 32)
                    .background(folder.isEmpty ? GammaTheme.line : .clear, in: RoundedRectangle(cornerRadius: 5))
            }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Library home")
            Text("Gamma").font(.system(size: 15, weight: .semibold))
            if !folder.isEmpty {
                Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(.tertiary)
                Button(folder.split(separator: "/").last.map(String.init) ?? folder) {
                    folder = folder.split(separator: "/").dropLast().joined(separator: "/")
                }.font(.system(size: 13)).lineLimit(1).buttonStyle(.plain).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(.secondary)
                TextField("Search library", text: $search).font(.system(size: 13)).textFieldStyle(.plain)
                    .accessibilityIdentifier("library-search")
                if !search.isEmpty {
                    Button { search = "" } label: { Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(.tertiary) }
                        .buttonStyle(.plain).accessibilityLabel("Clear search")
                }
            }.padding(.horizontal, 10).frame(width: compact ? 155 : 240, height: 32)
                .background(GammaTheme.notes, in: RoundedRectangle(cornerRadius: 6))
            Button { Task { await workspace.refreshLibrary(); await workspace.retrySync() } } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 14)).frame(width: 28, height: 32)
            }.buttonStyle(.plain).foregroundStyle(.secondary).disabled(workspace.busy || workspace.syncing).accessibilityLabel("Refresh library")
            Button { showStatus.toggle() } label: {
                Image(systemName: workspace.syncUnavailable || workspace.errorMessage != nil ? "exclamationmark.icloud" : workspace.status == "Synced with Gamma" ? "checkmark.icloud" : "icloud")
                    .font(.system(size: 15)).foregroundStyle(workspace.syncUnavailable ? Color.orange : Color.secondary).frame(width: 28, height: 32)
            }.buttonStyle(.plain).accessibilityLabel("Sync status")
                .popover(isPresented: $showStatus) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Synchronization").font(.headline)
                        Text(workspace.errorMessage ?? workspace.status).font(.subheadline)
                        Button("Retry") { Task { await workspace.retrySync() } }.disabled(workspace.syncing)
                    }.padding(20).frame(width: 300).presentationCompactAdaptation(.popover)
                }
            Menu {
                Text(workspace.username ?? "Gamma")
                Button("Sign out", role: .destructive) { Task { await workspace.signOut() } }
            } label: {
                Image(systemName: "person.crop.circle").font(.system(size: 17)).foregroundStyle(.secondary).frame(width: 30, height: 32)
            }.disabled(workspace.busy || workspace.syncing).accessibilityLabel("Account")
        }.padding(.horizontal, 16).frame(height: 52).background(GammaTheme.surface)
    }
    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            caption("RECENTLY VIEWED")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(recent) { paper in
                        Button { open(paper) } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(paper.content).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading).frame(height: 35, alignment: .top)
                                Spacer(minLength: 0)
                                HStack(spacing: 5) {
                                    Image(systemName: "doc.text").font(.system(size: 9))
                                    Text("PDF").font(.system(size: 10))
                                    Spacer()
                                    if let path = paper.folders.first {
                                        Text(path.split(separator: "/").last.map(String.init) ?? path).font(.system(size: 10)).lineLimit(1)
                                    }
                                }.foregroundStyle(.secondary)
                            }.padding(13).frame(width: 184, height: 96)
                                .background(GammaTheme.surface, in: RoundedRectangle(cornerRadius: 7))
                                .overlay(RoundedRectangle(cornerRadius: 7).stroke(GammaTheme.line, lineWidth: 1))
                        }.buttonStyle(.plain).disabled(workspace.busy)
                    }
                }
            }
        }
    }
    private var foldersSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            caption("FOLDERS").padding(.bottom, 7)
            ForEach(childFolders, id: \.self) { path in
                Button { folder = path } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "folder").font(.system(size: 17)).foregroundStyle(GammaTheme.accent)
                        Text(path.split(separator: "/").last.map(String.init) ?? path).font(.system(size: 14))
                        Spacer()
                        Text("\(workspace.papers.filter { Self.belongs($0, to: path) }.count)")
                            .font(.system(size: 10)).foregroundStyle(.secondary).padding(.horizontal, 7).padding(.vertical, 2)
                            .background(GammaTheme.line.opacity(0.5), in: Capsule())
                        Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(.tertiary)
                    }.padding(.horizontal, 8).frame(height: 36).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("folder-\(path)")
            }
        }
    }
    private var filesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                caption(search.isEmpty ? (folder.isEmpty ? "ALL FILES" : "FILES") : "SEARCH RESULTS")
                Text("\(filtered.count)").font(.system(size: 10)).foregroundStyle(.tertiary)
                Spacer()
                Menu {
                    Button("Recently modified") { alphabetical = false }
                    Button("Title A–Z") { alphabetical = true }
                } label: {
                    HStack(spacing: 7) {
                        Text(alphabetical ? "Title A–Z" : "Recently modified")
                        Image(systemName: "chevron.down").font(.system(size: 8))
                    }.font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 9).frame(height: 28)
                        .background(GammaTheme.surface, in: RoundedRectangle(cornerRadius: 5))
                }
                HStack(spacing: 2) {
                    layoutButton("List view", symbol: "list.bullet", active: !grid) { grid = false }
                    layoutButton("Grid view", symbol: "square.grid.2x2", active: grid) { grid = true }
                }.padding(2).background(GammaTheme.line.opacity(0.45), in: RoundedRectangle(cornerRadius: 6))
            }
            if grid {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
                    ForEach(filtered) { paper in
                        Button { open(paper) } label: {
                            VStack(alignment: .leading, spacing: 14) {
                                Image(systemName: "doc.richtext").font(.system(size: 26, weight: .light)).foregroundStyle(.secondary)
                                Text(paper.content).font(.system(size: 14, weight: .medium)).lineLimit(3).frame(height: 56, alignment: .top)
                                folderChips(paper)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                                .background(GammaTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(GammaTheme.line))
                        }.buttonStyle(.plain).disabled(workspace.busy)
                    }
                }
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(filtered) { paper in
                        Button { open(paper) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "doc.text").font(.system(size: 16, weight: .light)).foregroundStyle(.secondary).frame(width: 20)
                                Text(paper.content.isEmpty ? "Untitled PDF" : paper.content).font(.system(size: 14)).lineLimit(2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                folderChips(paper)
                            }.padding(.horizontal, 8).frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(workspace.busy).accessibilityIdentifier("gamma-page-\(paper.id)")
                    }
                }
            }
            if filtered.isEmpty {
                VStack(spacing: 9) {
                    Image(systemName: search.isEmpty ? "books.vertical" : "magnifyingglass").font(.system(size: 26, weight: .light))
                    Text(search.isEmpty ? "No PDFs in this folder" : "No matching papers").font(.subheadline)
                    if !search.isEmpty { Button("Clear search") { search = "" }.font(.caption) }
                }.foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 54)
            }
        }
    }
    private func caption(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .medium)).tracking(1).foregroundStyle(.secondary)
    }
    private func layoutButton(_ label: String, symbol: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 12)).frame(width: 28, height: 25)
                .foregroundStyle(active ? GammaTheme.accent : Color.secondary)
                .background(active ? GammaTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 5))
        }.buttonStyle(.plain).accessibilityLabel(label)
    }
    private func folderChips(_ paper: GammaPaper) -> some View {
        HStack(spacing: 8) {
            if let path = paper.folders.first {
                Label(path.split(separator: "/").last.map(String.init) ?? path, systemImage: "folder")
                    .font(.system(size: 10)).foregroundStyle(GammaTheme.accent).lineLimit(1)
            }
            Text("PDF").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
    }
    private func open(_ paper: GammaPaper) { Task { await workspace.open(paper) } }
    static func belongs(_ paper: GammaPaper, to folder: String) -> Bool {
        folder.isEmpty || paper.folders.contains { $0 == folder || $0.hasPrefix(folder + "/") }
    }
    private var filtered: [GammaPaper] {
        workspace.papers.filter { Self.belongs($0, to: folder) && (search.isEmpty || $0.content.localizedCaseInsensitiveContains(search)) }
            .sorted {
                if !alphabetical && $0.updatedAt != $1.updatedAt { return ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
                return $0.content.localizedStandardCompare($1.content) == .orderedAscending
            }
    }
    private var recent: [GammaPaper] {
        workspace.recentPageIDs.compactMap { id in workspace.papers.first { $0.id == id } }
    }
    private var childFolders: [String] {
        let prefix = folder.isEmpty ? "" : folder + "/"
        return Array(Set(workspace.papers.flatMap(\.folders).compactMap { path -> String? in
            guard path.hasPrefix(prefix), path != folder else { return nil }
            let remaining = String(path.dropFirst(prefix.count))
            guard let next = remaining.split(separator: "/").first else { return nil }
            return prefix + next
        })).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}
