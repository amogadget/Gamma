"""Portable standalone UI source contracts; NOT Swift compilation or device UI tests.

Run: python3 ipad/scripts/test_native_local_ui_contract.py
"""
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "GammaIPad" / "App"


class LocalUIContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.library = (APP / "GammaLibraryView.swift").read_text()
        cls.reader = (APP / "GammaReaderView.swift").read_text()
        cls.recording = (APP / "GammaRecordingView.swift").read_text()
        cls.root = (APP / "GammaIPadApp.swift").read_text()
        cls.workspace = (APP / "GammaWorkspace.swift").read_text()
        cls.local = (APP / "GammaWorkspaceLocal.swift").read_text()

    def test_pdf_picker_delegates_import_without_owning_storage(self):
        self.assertIn('allowedContentTypes: [UTType.pdf]', self.library)
        self.assertIn('allowsMultipleSelection: false', self.library)
        self.assertIn('guard workspace.isLocal, let url = urls.first', self.library)
        self.assertIn('await workspace.importLocalPDF(url: url)', self.library)
        self.assertNotIn('startAccessingSecurityScopedResource', self.library)
        self.assertIn('NSUserCancelledError', self.library)
        self.assertIn('else if workspace.isLocal {', self.library)
        self.assertIn('Import a PDF to read, write and record without an account.', self.library)

    def test_local_library_hides_server_controls(self):
        self.assertIn('workspace.isLocal ? "On This iPad" : "Gamma"', self.library)
        server_toolbar = self.library.split('if workspace.isLocal {\n                importButton\n            } else {', 1)[1].split('private var recentSection', 1)[0]
        for text in ['"Sync status"', '"Sign out"', '"Account"']:
            self.assertIn(text, server_toolbar)
        self.assertIn('if !workspace.isLocal {\n                Button { showDownloads', self.library)
        self.assertIn('if !workspace.isLocal {\n                Button(selecting', self.library)
        self.assertEqual(self.library.count('if !workspace.isLocal {\n                                Button("Download PDF'), 3)
        self.assertIn('if !workspace.isLocal { await workspace.retrySync() }', self.library)

    def test_reader_has_local_status_without_cloud_or_retry(self):
        status = self.reader.split('if workspace.isLocal {\n                Button { showStatus.toggle()', 1)[1].split('} else {', 1)[0]
        self.assertIn('Saved on This iPad', status)
        self.assertIn('recorder.hasPendingSave', status)
        for remote in ['pendingCount', 'icloud', 'retrySync', 'Synchronization']:
            self.assertNotIn(remote, status)
        self.assertIn('if !workspace.isLocal { Task { await workspace.sync() } }', self.reader)
        self.assertIn('if !workspace.isLocal, workspace.page?.outbox', self.reader)
        self.assertIn('if !workspace.isLocal, workspace.page?.outbox', self.recording)

    def test_failed_canvas_latch_survives_stroke_end(self):
        self.assertIn('failedInkPages.insert(page)', self.reader)
        self.assertIn('failedInkPages.remove(page)', self.reader)
        self.assertIn('activeInkPages.insert(page)', self.reader)
        self.assertIn('activeInkPages.remove(page)', self.reader)
        self.assertEqual(self.reader.count('guard !workspace.nativeWriteInProgress else'), 2)
        ended = self.reader.split('}, onInkEnded: { page in', 1)[1].split('replayActive:', 1)[0]
        self.assertIn('!activeInkPages.isEmpty || !failedInkPages.isEmpty', ended)
        self.assertNotIn('nativeWriteInProgress = false', ended)
        self.assertIn('workspace.inkEnded(blockID: inkID)', ended)
        generic_error = self.reader.split('}, onError: {', 1)[1].split('isDrawing:', 1)[0]
        self.assertNotIn('nativeWriteInProgress =', generic_error)
        self.assertIn('unsaved-handwriting-warning', self.reader)
        self.assertIn('saving retries automatically', self.reader)

    def test_root_allows_local_without_a_username_and_resumes_server_explicitly(self):
        self.assertIn('workspace.username == nil && !workspace.isLocal', self.root)
        self.assertIn('await workspace.restoreInitialLibrary()', self.root)
        self.assertIn('if !(await workspace.resumeServerLibrary())', self.root)
        self.assertIn('Use on this iPad — no account needed', self.root)
        self.assertIn('!workspace.canDisconnectServer', self.root)
        menu = self.root.split('private var libraryModeMenu:', 1)[1].split('private var signIn:', 1)[0]
        self.assertNotIn('workspace.paper != nil', menu)
        self.assertIn('Disconnect server · On this iPad', menu)
        self.assertIn('if selectedMode == nil { restoreServer = try sessionStore.load() != nil }', self.local)
        self.assertNotIn('sessionAPIFactory(', self.local)

    def test_live_web_editor_is_not_torn_down_for_mode_switch(self):
        self.assertIn('webSafelyPausedForNative = true', self.root)
        guarded = self.root.split('private func beginDisconnect()', 1)[1].split('private func finishDisconnect(', 1)[0]
        self.assertIn('await webCommands.prepareDisconnect()', guarded)
        self.assertIn('if !result.ok', guarded)
        self.assertIn('disconnectRecovery = result.recovery', guarded)
        self.assertIn('showDisconnectConfirmation = true', guarded)
        self.assertIn('await webCommands.cancelDisconnect()', self.root)
        self.assertIn('await workspace.disconnectServerToLocal(recovery: recovery)', self.root)
        self.assertNotIn('Use On this iPad next launch', self.root)

    def test_failed_primary_save_has_explicit_retry_and_keeps_server_canvas_retry(self):
        self.assertIn('if workspace.hasFailedNativeSave', self.reader)
        self.assertIn('Button("Retry save")', self.reader)
        self.assertIn('if workspace.retryNativeSave()', self.reader)
        persist = self.workspace.split('private func persist(', 1)[1].split('func retryNativeSave()', 1)[0]
        self.assertIn('failed.cache === cache', persist)
        self.assertNotIn('failed.cache === cache, isLocal', persist)
        commit = self.workspace.split('private func commitNativeSnapshot(', 1)[1].split('private func latest(', 1)[0]
        self.assertLess(commit.index('try cache.savePage(saved)'), commit.index('failedNativeSave = nil'))
        self.assertIn('if failedNativeSave == nil { failedNativeSave = (cache, snapshot) }', commit)
        failure = commit.split('} catch {', 1)[1]
        self.assertIn('if isLocal {', failure, 'Server recording retries must retain their established merge semantics')

    def test_recording_and_reader_safety_paths_remain(self):
        self.assertEqual(self.reader.count('workspace.closeReader()'), 2)
        self.assertIn('Leave — unsaved strokes may be lost', self.reader)
        self.assertIn('recorder.hasPendingSave', self.recording)
        self.assertIn('Button("Pause") { recorder.pause() }', self.recording)
        self.assertIn('Button("Retry local save") { recorder.retrySave() }', self.recording)
        self.assertIn('recorder.pausePlayback()', self.reader)
        self.assertIn('replayDrawing: { workspace.replayDrawing', self.reader)


if __name__ == '__main__':
    unittest.main()
