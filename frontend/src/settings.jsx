import React from "react";
import { ALT_LABEL, API, apiJson, fmtBytes, copyText, isUnverifiedPaperMeta } from "./utils";
import { MenuSelect } from "./menus";
import {
  PaneHead, Section, Row, Toggle, Segmented, UnitInput, CharSlider, approxPages,
  Stat, Empty, QuotaMeter,
} from "./settingsKit";
import { AiSettings } from "./settingsAi";
import { UsersSettings } from "./settingsUsers";
import { TRANSLATE_LANGS } from "./prefs";
import {
  ActivityIcon,
  BookIcon,
  BugIcon,
  CloudDownloadIcon,
  ContrastIcon,
  CornerDownLeftIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  HardDriveIcon,
  HighlightIcon,
  HomeIcon,
  ImportIcon,
  KeyIcon,
  LabelIcon,
  LanguagesIcon,
  LayoutIcon,
  ListIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  MoveVerticalIcon,
  PaperIcon,
  PenIcon,
  RectSelectIcon,
  RefreshIcon,
  ScissorsIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
  TerminalIcon,
  TypeIcon,
  UserIcon,
  UsersIcon,
} from "./icons";

// Nine panes in four groups. Each pane is a stack of Sections, each Section a
// stack of Rows — icon · label · one short hint · control (primitives in
// settingsKit.jsx; the Providers and Users panes live in settingsAi.jsx /
// settingsUsers.jsx). The paragraph that used to sit under every label now
// lives in the row's `title`, so a pane scans as a column of pictures and
// still explains itself on hover.
const NAV_GROUPS = [
  ["Workspace", [
    ["general", "General", SettingsIcon],
    ["library", "Library", ListIcon],
  ]],
  ["Reading", [
    ["viewer", "PDF viewer", FileIcon],
    ["search", "Search", SearchIcon],
    ["notes", "Notes", FileTextIcon],
  ]],
  ["AI", [
    ["ai", "Provider and models", KeyIcon],
    ["assistant", "Assistant", SparklesIcon],
    ["prompts", "Prompts", MessageSquareIcon],
  ]],
  ["Account", [
    ["users", "Users", UsersIcon], // relabelled "You" for non-admins (see SettingsDialog)
    ["advanced", "Advanced", ActivityIcon],
  ]],
];
// Older entry points (and anything that remembered a pane id) still resolve.
const PANE_ALIASES = {
  papers: "general",
  context: "assistant",
  diagnostics: "advanced", account: "users",
};

// --- General: reading, notes, interface -------------------------------------

const THEME_ICON = { dark: MoonIcon, light: SunIcon, sepia: EyeIcon, gray: ContrastIcon, system: MonitorIcon };

function GeneralSettings({ value }) {
  return (
    <>
      <PaneHead icon={SettingsIcon} title="General">
        Appearance follows your account across devices; paper preferences are saved in this browser.
      </PaneHead>
      <Section title="Appearance">
        <Row
          icon={THEME_ICON[value.theme] || MonitorIcon}
          label="Theme"
          hint="Sepia and Gray are eye-comfort modes; System follows the OS"
          title="Light or dark interface. System tracks the operating system's appearance and switches live when it changes. Sepia and Gray are eye-comfort modes that soften both the interface and the PDF page: Sepia a warm Solarized-Light paper tone that also cuts blue light, Gray a neutral light-gray with no color cast. Both replace the glare of a white background and soften pure-black ink to charcoal."
        >
          <Segmented
            value={value.theme}
            onChange={value.setTheme}
            options={[
              // values = THEMES in prefs.js (its codec validates them)
              ["system", "System", MonitorIcon, "Follow the OS light/dark setting"],
              ["light", "Light", SunIcon, "Always light"],
              ["dark", "Dark", MoonIcon, "Always dark"],
              ["sepia", "Sepia", EyeIcon, "Eye comfort: warm paper tones for the interface and PDF pages"],
              ["gray", "Gray", ContrastIcon, "Eye comfort: neutral light gray, no color cast"],
            ]}
          />
        </Row>
        <Toggle
          icon={MoonIcon}
          label="Flip page colors"
          hint="Dark PDF pages — light text on a dark background"
          title="Render PDF pages inverted for reading in the dark. Display-only: highlights, exports and the stored file keep their real colors. Figures and photos come out as negatives, so scanned papers may look better with this off. Takes precedence over the Sepia theme's warm page tint."
          checked={value.pdfDarkPage}
          onChange={value.setPdfDarkPage}
        />
      </Section>
      <Section title="Papers">
        <Toggle
          icon={CloudDownloadIcon}
          label="Open-access fallback"
          hint="Fetch a free copy when a publisher blocks the PDF"
          title="When a publisher PDF is paywalled or refuses to download, load a legal open-access copy instead — usually the arXiv version. A note tells you when the substitute isn't the published version."
          checked={value.oaFallback}
          onChange={value.setOaFallback}
        />
        <Toggle
          icon={SparklesIcon}
          label="Auto-fetch metadata"
          hint="Title, authors and BibTeX on first open"
          title="Look up title, authors, venue and BibTeX the first time a paper opens (arXiv → DOI → AI). Turn this off to fetch only via the refresh button in the metadata popover."
          checked={value.metaAutoFetch}
          onChange={value.setMetaAutoFetch}
        />
        <Toggle
          icon={HardDriveIcon}
          label="Save external PDFs"
          hint="Keep a server copy of PDFs opened from a URL"
          title="Keep a server copy of PDFs opened from a URL, so they load instantly next time and survive dead links."
          checked={value.pdfSaveLocal}
          onChange={value.setPdfSaveLocal}
        />
      </Section>
    </>
  );
}

// --- Reading: PDF viewer + search + notes -----------------------------------

function ViewerSettings({ value }) {
  return (
    <>
      <PaneHead icon={FileIcon} title="PDF viewer">
        How the PDF pane scrolls and what it paints.
      </PaneHead>
      <Section title="Viewing">
        <Toggle
          icon={MoveVerticalIcon}
          label="Snap vertical scrolling"
          hint="Straight one-finger swipes don't drift sideways"
          title="On a touch screen, a one-finger swipe that's roughly straight up or down scrolls a zoomed-in PDF vertically only, so the page doesn't drift sideways while you read. Diagonal and sideways swipes still pan freely."
          checked={value.snapVertical}
          onChange={value.setSnapVertical}
        />
        <Row
          icon={HighlightIcon}
          label="Annotations inside the file"
          hint="Imported as highlights — what happens to the originals"
          title={"Highlights, notes and rectangles saved inside a PDF file (a Gamma export, SumatraPDF, Acrobat…) are imported as regular highlights. This controls the embedded originals so they don't render twice: Hide leaves the file untouched, Strip removes them from the stored PDF on import."}
        >
          <Segmented
            value={value.embAnnots}
            onChange={value.setEmbAnnots}
            options={[
              ["hide", "Hide", EyeOffIcon, "Leave the file untouched; the viewer just doesn't paint them"],
              ["strip", "Strip", ScissorsIcon, "Rewrite the stored PDF without them once they're imported"],
            ]}
          />
        </Row>
      </Section>
      <Section title="Translation">
        <Toggle
          icon={LanguagesIcon}
          label="Translation button"
          hint="The languages button in the viewer's zoom column"
          title="Show the translate button in the PDF viewer. Click translates the current page (or shows/hides an existing translation); right-click or long-press opens the options, including translating the whole document. Nothing translates until you ask, and the selected page text is sent to your configured AI provider when you do."
          checked={value.translateEnabled}
          onChange={value.setTranslateEnabled}
        />
        <Row
          icon={GlobeIcon}
          label="Translate into"
          hint="Language for the viewer's translated view"
          title={`The translated view (the languages button in the PDF viewer's zoom column) redraws each paragraph in this language in place — figures and layout stay put, and holding ${ALT_LABEL} peeks at the original. Paragraph translations are cached per language and model, so re-reading a page is free.`}
        >
          <MenuSelect
            label="Translation language"
            value={value.translateLang}
            onChange={value.setTranslateLang}
            options={TRANSLATE_LANGS}
          />
        </Row>
        <Row
          icon={SparklesIcon}
          label="Translation model"
          hint="Used when translating pages"
          title="Model used to translate page text. Translation is a bulk job — a fast, cheap model usually reads fine and costs much less than the chat model."
        >
          <TranslateModelSelect value={value} />
        </Row>
        <Row
          icon={ActivityIcon}
          label="Translation effort"
          hint="Low makes reasoning models translate much faster"
          title="Reasoning effort sent with translation calls. Reasoning models spend their thinking budget before writing any output, which is wasted on translation — Low or Minimal typically cuts a page from ~20s to a few seconds. Default omits the parameter (some models reject it)."
        >
          <MenuSelect
            label="Translation effort"
            value={value.translateEffort}
            onChange={value.setTranslateEffort}
            options={[["", "Default"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]]}
          />
        </Row>
        <Row
          icon={RefreshIcon}
          label="Parallel requests"
          hint="Translation calls in flight at once (1–8)"
          title="A page is translated in small chunks, this many at a time; a whole-document job streams chunks across pages and never exceeds it. Higher is faster until your provider's rate limit pushes back — every slot is a concurrent paid request."
        >
          <UnitInput value={value.translateParallel} unit="calls" min={1}
            onCommit={(raw) => {
              const n = Number.parseInt(raw, 10);
              if (Number.isFinite(n)) value.setTranslateParallel(Math.max(1, Math.min(8, n)));
            }} />
        </Row>
      </Section>
    </>
  );
}

// "" = follow the chat model; a stale pick (provider/model removed) also
// falls back. Same shape as the model pickers in the Providers pane.
function TranslateModelSelect({ value }) {
  const models = value.aiModels || [];
  const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
  const current = value.translateModel && models.some((m) => m.id === value.translateModel) ? value.translateModel : "";
  return (
    <MenuSelect
      label="Translation model" value={current} onChange={value.setTranslateModel}
      options={[
        ["", "Same as chat"],
        ...models.map((m) => [m.id, multiProvider ? `${m.model} · ${m.provider_name || m.provider}` : m.model]),
      ]}
    />
  );
}

function SearchSettings({ value }) {
  return (
    <>
      <PaneHead icon={SearchIcon} title="Search">
        Your notes and every PDF in the library. PDFs are indexed in the background.
      </PaneHead>
      <Section title="Auto-expand results">
        <Toggle
          icon={HomeIcon}
          label="On the home page"
          hint="Search from the library opens with full result lists"
          title="With no PDF open the compact find bar has nothing to show, so the home page defaults to expanded. Turn off to start collapsed anyway."
          checked={value.searchDetailsHome}
          onChange={value.setSearchDetailsHome}
        />
        <Toggle
          icon={PaperIcon}
          label="While reading a paper"
          hint="Off: search opens as a compact browser-style find bar"
          title="In a paper, Ctrl+F defaults to the compact find bar (match counter and next/previous only). Turn on to open with the full grouped result lists instead."
          checked={value.searchDetailsPaper}
          onChange={value.setSearchDetailsPaper}
        />
      </Section>
    </>
  );
}

function NotesSettings({ value }) {
  return (
    <>
      <PaneHead icon={FileTextIcon} title="Notes">
        How the outliner behaves while you write.
      </PaneHead>
      <Section title="Editing">
        <Toggle
          icon={CornerDownLeftIcon}
          label="Enter starts a new note"
          hint="Off: Enter breaks the line, Shift+Enter starts a note"
          title="Logseq-style: Enter creates the next note, Shift+Enter types a line break inside the current one. Turn off to swap them (the + button under the notes always creates one)."
          checked={value.enterNewNote}
          onChange={value.setEnterNewNote}
        />
        <Toggle
          icon={MessageSquareIcon}
          label="Note badges on highlights"
          hint="Bubble on a highlight that carries a note"
          title="Show a small speech-bubble next to a highlight in the PDF when you've typed a note on it. Click the bubble to jump to the note."
          checked={value.hlNoteBadges}
          onChange={value.setHlNoteBadges}
        />
      </Section>
    </>
  );
}

// Kick off a full search-index rebuild (the Library pane's Index section).
async function requestReindex(setStatus, scheduledSuffix) {
  try {
    const result = await apiJson(`${API}/search-reindex`, { method: "POST" });
    setStatus(result.busy
      ? "Indexing is already running—see the tasks popover."
      : result.scheduled
        ? `Re-indexing ${result.scheduled} paper${result.scheduled === 1 ? "" : "s"} ${scheduledSuffix}`
        : "No papers with PDFs to index.");
  } catch (err) {
    setStatus(`Reindex failed: ${err.message}`);
  }
}

// --- Library: storage + per-paper health ------------------------------------

// Admin-only server-wide default storage limits (users.db via
// /api/admin/settings). Per-account overrides live in the Users pane.
function ServerLimitRows({ setStatus, refreshQuota }) {
  const [saved, setSaved] = React.useState(null); // {max_upload_mb, quota_mb}
  const [draft, setDraft] = React.useState({ max_upload_mb: "", quota_mb: "" });
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    apiJson(`${API}/admin/settings`)
      .then((d) => {
        setSaved(d);
        setDraft({ max_upload_mb: String(d.max_upload_mb), quota_mb: String(d.quota_mb) });
      })
      .catch((err) => setError(err.message));
  }, []);
  async function save(key, label) {
    try {
      const d = await apiJson(`${API}/admin/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: parseInt(draft[key], 10) }),
      });
      setSaved((prev) => ({ ...prev, ...d }));
      setDraft({ max_upload_mb: String(d.max_upload_mb), quota_mb: String(d.quota_mb) });
      refreshQuota?.();
      setStatus(`${label} saved.`);
    } catch (err) {
      setStatus(`Could not save: ${err.message}`);
    }
  }
  function row(key, icon, label, hint, title, min, saveLabel) {
    const parsed = parseInt(draft[key], 10);
    const valid = Number.isFinite(parsed) && parsed >= min;
    const dirty = saved && valid && parsed !== saved[key];
    return (
      <Row icon={icon} label={label} hint={error || hint} title={title}>
        {error ? null : (
          <span className="setSlider">
            <UnitInput
              unit="MB" min={min}
              value={draft[key]}
              onChange={(next) => setDraft((f) => ({ ...f, [key]: next }))}
              onEnter={() => { if (dirty) save(key, saveLabel); }}
            />
            <button className="uiBtn sm" disabled={!dirty} onClick={() => save(key, saveLabel)}>Save</button>
          </span>
        )}
      </Row>
    );
  }
  return (
    <>
      {row("max_upload_mb", ImportIcon, "Default max upload", "Largest single PDF or image, per account",
        "Server-wide cap on a single uploaded PDF or image. Override it per account from the Users pane. Admins only.", 1, "Upload limit")}
      {row("quota_mb", ServerIcon, "Default quota", "Total uploads per account · 0 = unlimited",
        "Server-wide total uploads storage per account; 0 means unlimited. Override it per account from the Users pane. Admins only.", 0, "Storage quota")}
    </>
  );
}

// Everyone sees their own usage against their effective limits (GET /api/quota).
function StorageCard() {
  const [q, setQ] = React.useState(null);
  React.useEffect(() => { apiJson(`${API}/quota`).then(setQ).catch(() => {}); }, []);
  if (!q) return null;
  return (
    <div className="setCard">
      <div className="setCardHead">
        <span className="setIcon"><HardDriveIcon size={15} /></span>
        <span className="settingText">
          <span className="settingLabel">Uploaded files</span>
          <span className="settingDesc">PDFs and images on the server · up to {q.max_upload_mb} MB each</span>
        </span>
        <span className="setCardVal">
          {fmtBytes(q.used_bytes)}
          <em>{q.quota_mb ? ` / ${fmtBytes(q.quota_mb * 1024 * 1024)}` : " · no quota"}</em>
        </span>
      </div>
      <QuotaMeter usedBytes={q.used_bytes} quotaMb={q.quota_mb} barOnly />
    </div>
  );
}

// Whole-library import from Zotero: the user zips their File → Export Library
// → "Zotero RDF" folder (with files, notes and annotations) and uploads it.
// Collections become folders, tags labels, notes child blocks; annotations ride
// inside the exported PDFs and reuse the embedded-annotations importer (the
// strip-vs-hide choice follows the standing Settings → PDF viewer preference).
function ZoteroImportRow({ value, onDone }) {
  const fileRef = React.useRef(null);
  const [busy, setBusy] = React.useState(false);
  async function run(file) {
    setBusy(true);
    value.setStatus("Importing Zotero library — this can take a while for big exports…");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("strip", value.stripAnnots ? "true" : "false");
      const data = await apiJson(`${API}/import/zotero`, { method: "POST", body: fd });
      const problems = (data.skipped?.length || 0) + (data.warnings?.length || 0);
      if (problems) {
        [...(data.skipped || []), ...(data.warnings || [])].forEach((s) =>
          console.warn(`Zotero import: ${s.title} — ${s.reason}`));
      }
      const bits = [
        `${data.pages_created} new page${data.pages_created === 1 ? "" : "s"}`,
        data.pages_merged ? `${data.pages_merged} updated` : "",
        data.annotations_imported ? `${data.annotations_imported} annotations` : "",
        data.notes_imported ? `${data.notes_imported} notes` : "",
        problems ? `${problems} issue${problems === 1 ? "" : "s"} (see browser console)` : "",
      ].filter(Boolean).join(" · ");
      value.setStatus(`Zotero import: ${bits}.`);
      onDone?.();
    } catch (err) {
      value.setStatus(`Zotero import failed: ${err.message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  return (
    <Row
      icon={BookIcon}
      label="Zotero library"
      hint={"Zip of a “Zotero RDF” export, with files and notes"}
      title={'In Zotero: File → Export Library → format "Zotero RDF", check "Export Files" and "Export Notes" (annotations are included in the PDFs). Zip the exported folder and upload it here. Collections become folders, tags become labels, notes become blocks; re-importing updates instead of duplicating.'}
    >
      <input
        ref={fileRef} type="file" accept=".zip,application/zip" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) run(f); }}
      />
      <button className="uiBtn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? "Importing…" : "Choose .zip…"}
      </button>
    </Row>
  );
}

function LibrarySettings({ value }) {
  // bumping this after an import re-fetches the Papers table below
  const [importNonce, setImportNonce] = React.useState(0);
  return (
    <>
      <PaneHead icon={ListIcon} title="Library">
        How the home library presents itself, storage, and per-paper health of metadata, extracted text and the search index.
      </PaneHead>
      <Section title="Display">
        <Toggle
          icon={EyeIcon}
          label="Recents thumbnails"
          hint="Page snapshots on the Recently-viewed cards"
          title="Show each recently-viewed paper as a small snapshot of the page where you left off, captured on this device while you read. Off shows the file icon instead and stops capturing new snapshots. Library cards always use the plain file icon."
          checked={value.recentThumbs}
          onChange={value.setRecentThumbs}
        />
        <Row
          icon={LabelIcon}
          label="File labels"
          hint="Folder and label chips on library cards and rows"
          title="Show each page's folders and labels as small chips on the home library — the file list, the grid cards and the Recently-viewed strip. Chips are informational; labels are still edited from the paper view or the right-click menus."
        >
          <MenuSelect
            label="File labels"
            value={value.fileLabels}
            onChange={value.setFileLabels}
            options={[
              ["both", "Folders & labels"],
              ["folders", "Folders only"],
              ["labels", "Labels only"],
              ["off", "Hidden"],
            ]}
          />
        </Row>
      </Section>
      <Section title="Storage">
        <StorageCard />
        {value.isAdmin ? <ServerLimitRows setStatus={value.setStatus} refreshQuota={value.refreshQuota} /> : null}
      </Section>
      <Section title="Import">
        <ZoteroImportRow
          value={value}
          onDone={() => {
            setImportNonce((n) => n + 1);
            value.refreshQuota?.();
            value.onLibraryChange?.();
          }}
        />
      </Section>
      <Section title="Index">
        <Row
          icon={RefreshIcon}
          label="PDF text index"
          hint={value.indexTask?.active ? "Rebuilding — progress in the tasks popover" : "Re-extract every paper if results look stale"}
          title="Full-text search reads a per-user index built from the extracted PDF text. Rebuild it when library-wide results look stale or incomplete."
        >
          <button className="uiBtn sm" disabled={value.indexTask?.active} onClick={() => requestReindex(value.setStatus, "in the background.")}>
            {value.indexTask?.active ? "Indexing…" : "Rebuild"}
          </button>
        </Row>
      </Section>
      <MetaStatusSection value={value} refreshNonce={importNonce} />
    </>
  );
}

// Library-wide health: per paper, whether metadata resolved, whether the PDF
// yielded extractable text, and whether the search index covers it — with
// batch retry for the metadata lookups. Text and index state come from the FTS
// index, so "unknown" means not visited yet, not broken; Reindex fills it in.
function MetaStatusSection({ value, refreshNonce = 0 }) {
  const [papers, setPapers] = React.useState(null); // null = loading
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(null); // {done, total, title} during a batch run
  const [sortMode, setSortMode] = React.useState("meta"); // meta | text | updated
  const [filterMode, setFilterMode] = React.useState("all"); // all | attention | unverified | missing | notext
  const stopRef = React.useRef(false);

  async function refresh() {
    try {
      const data = await apiJson(`${API}/metadata/status`);
      setPapers(data.papers || []);
      setError("");
      setSelected((prev) => new Set([...prev].filter((id) => (data.papers || []).some((p) => p.id === id))));
    } catch (err) {
      setError(err.message);
      setPapers((prev) => prev || []);
    }
  }
  React.useEffect(() => { refresh(); }, [refreshNonce]);

  // Indexing runs in a background thread server-side, so after scheduling we
  // re-poll the table a few times to let the dots fill in. A newer poll (or
  // unmount) cancels the older one.
  const pollRef = React.useRef(0);
  React.useEffect(() => () => { pollRef.current++; }, []);
  function pollRefresh() {
    const id = ++pollRef.current;
    [1500, 4000, 8000, 15000].forEach((ms) =>
      setTimeout(() => { if (pollRef.current === id) refresh(); }, ms));
  }

  // Index specific papers (the per-row button) without touching the rest.
  async function indexDocs(docIds) {
    try {
      const r = await apiJson(`${API}/search-reindex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_ids: docIds }),
      });
      value.setStatus(r.busy
        ? "Indexing is already running—try again when it finishes."
        : `Indexing ${docIds.length === 1 ? "1 paper" : `${docIds.length} papers`} in the background.`);
      pollRefresh();
    } catch (err) {
      value.setStatus(`Indexing failed: ${err.message}`);
    }
  }

  const list = papers || [];
  const textOk = (p) => (p.text_chars ?? 0) >= 50; // same threshold as /api/pdf-text-status
  // "Unverified": AI-extracted metadata claiming to be a paper — the same
  // records the red "!" flags on the metadata button. Missing metadata and
  // unverified records are what a batch (re)fetch can actually fix.
  const unverifiedPaper = (p) => p.has_meta && isUnverifiedPaperMeta(p.meta_source, p.meta_kind);
  const fetchable = (p) => !p.has_meta || unverifiedPaper(p);
  const noText = (p) => p.text_chars !== null && !textOk(p);
  const missing = list.filter((p) => !p.has_meta);
  const unverified = list.filter(unverifiedPaper);
  const needsWork = list.filter(fetchable);
  const counts = {
    verified: list.filter((p) => p.has_meta && !unverifiedPaper(p)).length,
    text: list.filter(textOk).length,
    indexed: list.filter((p) => p.indexed).length,
  };
  const FILTERS = {
    all: () => true,
    attention: (p) => fetchable(p) || noText(p),
    unverified: unverifiedPaper,
    missing: (p) => !p.has_meta,
    notext: noText,
  };
  // ISO timestamps compare lexicographically; unfinished-first sorts fall back
  // to recency inside each group.
  const shown = React.useMemo(() => {
    const byTime = (a, b) => (b.updated_at || "").localeCompare(a.updated_at || "");
    const arr = list.filter(FILTERS[filterMode] || FILTERS.all);
    if (sortMode === "meta") arr.sort((a, b) => (fetchable(b) ? 1 : 0) - (fetchable(a) ? 1 : 0) || byTime(a, b));
    else if (sortMode === "text") arr.sort((a, b) => (textOk(a) ? 1 : 0) - (textOk(b) ? 1 : 0) || byTime(a, b));
    else arr.sort(byTime);
    return arr;
  }, [list, sortMode, filterMode]);

  async function retry(targets) {
    if (!targets.length || busy) return;
    stopRef.current = false;
    let ok = 0, failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (stopRef.current) break;
      const paper = targets[i];
      setBusy({ done: i, total: targets.length, title: paper.title });
      try {
        await apiJson(`${API}/metadata/fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            block_id: paper.id,
            force: true,
            prompt: value.metaPrompt || "",
            model: value.metaFetchModel || "",
            context_char_limit: value.metaContextChars || 6000,
          }),
        });
        ok++;
      } catch {
        failed++;
      }
    }
    setBusy(null);
    value.setStatus(`Metadata: ${ok} fetched${failed ? `, ${failed} failed` : ""}${stopRef.current ? " (stopped)" : ""}.`);
    refresh();
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  // Select-all works on the filtered view, so "filter to unverified → select
  // all → fetch" is three clicks.
  const allSelected = shown.length > 0 && shown.every((p) => selected.has(p.id));
  // One adaptive primary action instead of three near-identical buttons: a
  // selection wins, otherwise it offers exactly the papers a fetch can fix
  // (missing metadata + unverified AI records).
  const targets = selected.size ? list.filter((p) => selected.has(p.id)) : needsWork;

  const cell = (tone, text, title) => (
    <span className={`metaCell ${tone}`} title={title}><i className="setDot" />{text}</span>
  );
  const metaCell = (p) => (
    p.has_meta
      ? p.meta_source === "ai"
        ? (p.meta_kind || "paper") === "paper"
          ? cell("bad", "AI", "AI-extracted, not confirmed by a registry — verify before citing")
          : cell("muted", `AI (${p.meta_kind})`, "AI-extracted; not a published paper, so there is no registry record to verify against")
        : cell("ok", p.meta_source || "yes", "Metadata resolved")
      : p.meta_error
        ? cell("bad", "failed", p.meta_error)
        : cell("muted", "none", "No metadata yet")
  );
  // Text and index are separate columns: extraction state is only known once
  // the indexer has visited the doc, so an unindexed paper shows "unknown".
  const textCell = (p) => (
    p.text_chars === null
      ? cell("muted", "unknown", "Unknown until the paper is indexed — Reindex to find out")
      : textOk(p)
        ? cell("ok", p.text_chars >= 1000 ? `${Math.round(p.text_chars / 1000)}k` : String(p.text_chars),
          `${p.text_chars.toLocaleString()} characters extracted`)
        : cell("bad", "no text", p.has_file ? "No text layer — scanned or image-only?" : "PDF file not on the server")
  );
  const indexCell = (p) => (
    p.indexed
      ? cell("ok", "indexed", "In the search index")
      : p.index_stale
        ? cell("muted", "stale", "Indexed with an older extractor version — Reindex refreshes it")
        : cell("muted", "—", "Not in the search index yet")
  );

  return (
    <Section
      title="Papers"
      action={
        <span className="metaStatActions">
          <MenuSelect
            label="Show papers" value={filterMode} onChange={setFilterMode}
            options={[
              ["all", `All (${list.length})`],
              ["attention", "Needs attention"],
              ["unverified", `Unverified AI (${unverified.length})`],
              ["missing", `Missing metadata (${missing.length})`],
              ["notext", "No text layer"],
            ]}
          />
          <MenuSelect
            label="Sort papers" value={sortMode} onChange={setSortMode}
            options={[
              ["meta", "Needs work first"],
              ["text", "Missing text first"],
              ["updated", "Recently modified"],
            ]}
          />
          <button className="uiBtn sm iconSq" aria-label="Reindex"
            title="Re-extract every paper into the search index (also fills in the text column)"
            onClick={() => { requestReindex(value.setStatus, "— text status fills in as it runs."); pollRefresh(); }}>
            <RefreshIcon size={13} />
          </button>
          <button className="uiBtn sm iconSq" onClick={refresh} disabled={!!busy} title="Reload this table" aria-label="Reload">
            <ActivityIcon size={13} />
          </button>
        </span>
      }
    >
      {papers === null ? <Empty icon={ListIcon}>Loading…</Empty> : null}
      {error ? <Empty icon={ActivityIcon}>Status unavailable — {error}</Empty> : null}
      {papers !== null && !list.length && !error ? <Empty icon={PaperIcon}>No papers yet — open a PDF first.</Empty> : null}
      {list.length ? (
        <>
          <div className="setStats">
            <Stat icon={PaperIcon} label="verified" value={counts.verified} total={list.length}
              title="Metadata from a registry (arXiv/DOI/Crossref), edited by hand, or a non-paper document — nothing left to verify. Missing and unverified AI records count against this." />
            <Stat icon={FileTextIcon} label="text layer" value={counts.text} total={list.length}
              title="Papers whose PDF yielded extractable text" />
            <Stat icon={SearchIcon} label="indexed" value={counts.indexed} total={list.length}
              title="Papers covered by the full-text search index" />
          </div>
          <div className="metaStatTable">
            <div className="metaStatRow metaStatHeader">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected((prev) => {
                  const next = new Set(prev);
                  shown.forEach((p) => (allSelected ? next.delete(p.id) : next.add(p.id)));
                  return next;
                })}
                title={allSelected ? "Clear the shown papers from the selection" : "Select all shown papers"}
              />
              <span>Paper</span>
              <span>Metadata</span>
              <span>Text</span>
              <span>Index</span>
              <span />
            </div>
            {!shown.length ? (
              <div className="metaStatRow" style={{ cursor: "default" }}>
                <span /><span className="metaStatTitle" style={{ color: "var(--text-dim)" }}>Nothing matches this filter.</span>
              </div>
            ) : null}
            {shown.map((p) => (
              <label key={p.id} className="metaStatRow">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span
                  className="metaStatTitle" title={`${p.title} — click to open`}
                  onClick={(e) => {
                    if (!value.openPaper) return;
                    e.preventDefault(); e.stopPropagation();
                    value.openPaper(p.id);
                  }}
                >{p.title}</span>
                {metaCell(p)}
                {textCell(p)}
                {indexCell(p)}
                {p.doc_id && p.has_file && (!p.indexed || p.index_stale || p.text_chars === null) ? (
                  <button
                    className="searchToggle" aria-label={`Index ${p.title}`}
                    title="Extract this paper's text into the search index now"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); indexDocs([p.doc_id]); }}
                  >
                    <RefreshIcon size={13} />
                  </button>
                ) : <span />}
              </label>
            ))}
          </div>
          {busy ? (
            <div className="metaStatBatchRow">
              <span className="metaStatProgress">Fetching {busy.done + 1}/{busy.total} — {busy.title}</span>
              <button className="uiBtn sm" onClick={() => { stopRef.current = true; }}>Stop</button>
            </div>
          ) : (
            <div className="metaStatBatchRow">
              <span className="metaStatProgress">
                {selected.size
                  ? `${selected.size} selected`
                  : needsWork.length
                    ? [missing.length && `${missing.length} missing metadata`,
                       unverified.length && `${unverified.length} unverified (AI)`]
                        .filter(Boolean).join(" · ")
                    : "Everything is verified"}
              </span>
              <button className="uiBtn sm primary" disabled={!targets.length} onClick={() => retry(targets)}
                title={selected.size ? "Fetch metadata for the selected papers"
                  : "Fetch metadata for papers that are missing it or have an unverified AI record"}>
                <SparklesIcon size={13} />{selected.size ? "Fetch selected" : "Fetch needed"}
              </button>
              <button className="uiBtn sm" disabled={!shown.length} onClick={() => retry(shown)}
                title={filterMode === "all"
                  ? "Re-fetch metadata for every paper, including ones that already have it"
                  : "Re-fetch metadata for every paper the current filter shows"}>
                {filterMode === "all" ? "Refetch all" : "Refetch shown"}
              </button>
            </div>
          )}
        </>
      ) : null}
    </Section>
  );
}

// --- Assistant: agent, chat, context budgets, prompts -----------------------

// One accordion instead of three stacked textareas: only the prompt being
// edited takes up space, and Restore default lights up only when it would
// change something. Everything starts collapsed — the section reads as a
// category list until a prompt is opened.
function PromptAccordion({ items }) {
  const [open, setOpen] = React.useState(null);
  return (
    <div className="setAccList">
      {items.map(({ key, label, icon: Icon, draft, setDraft, defaultValue, custom }) => {
        const isOpen = open === key;
        const modified = (draft || "").trim() !== (defaultValue || "").trim();
        return (
          <div key={key} className={`setAcc ${isOpen ? "open" : ""}`}>
            <button className="setAccHead" onClick={() => setOpen(isOpen ? null : key)}>
              <span className="setIcon"><Icon size={14} /></span>
              <span className="setAccName">{label}</span>
              {custom ? <span className="uiTag">custom</span> : null}
              <span className="setAccChevron">{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen ? (
              <div className="setAccBody">
                <textarea className="promptTextarea" value={draft} rows={6}
                  onChange={(event) => setDraft(event.target.value)} />
                <div className="reportModalBtns settingsAlignStart">
                  <button className="uiBtn sm" disabled={!modified} onClick={() => setDraft(defaultValue || "")}>
                    Restore default
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// Prompts pane: the three editable prompts as a collapsed accordion, with one
// Save button for all of them.
function PromptsSettings({ value }) {
  const prompts = [
    { key: "chat", label: "Chat system prompt", icon: MessageSquareIcon,
      draft: value.promptDraft, setDraft: value.setPromptDraft,
      defaultValue: value.aiInfo?.default_prompt, custom: !!value.chatSystem, saved: value.chatSystem },
    { key: "meta", label: "Metadata extraction", icon: PaperIcon,
      draft: value.metaPromptDraft, setDraft: value.setMetaPromptDraft,
      defaultValue: value.aiInfo?.metadata_prompt, custom: !!value.metaPrompt, saved: value.metaPrompt },
    { key: "cite", label: "PPT citation", icon: TypeIcon,
      draft: value.citePromptDraft, setDraft: value.setCitePromptDraft,
      defaultValue: value.aiInfo?.cite_prompt, custom: !!value.citePrompt, saved: value.citePrompt },
    { key: "agent", label: "Library agent", icon: SparklesIcon,
      draft: value.agentPromptDraft, setDraft: value.setAgentPromptDraft,
      defaultValue: value.aiInfo?.agent_prompt, custom: !!value.agentSystem, saved: value.agentSystem },
  ];
  // A stored "" means "use the default", so the effective saved text is the
  // custom one or the default — that is what a draft is dirty against.
  const dirty = prompts.some((p) => (p.draft || "").trim() !== (p.saved || p.defaultValue || "").trim());
  return (
    <>
      <PaneHead icon={MessageSquareIcon} title="Prompts">
        What each AI job is told. Empty or unchanged means the built-in default.
      </PaneHead>
      <Section
        title="Prompts"
        action={
          <button className={`uiBtn sm ${dirty ? "primary" : ""}`} disabled={!dirty} onClick={value.savePrompts}>
            {dirty ? "Save prompts" : "Saved"}
          </button>
        }
      >
        <PromptAccordion items={prompts} />
      </Section>
    </>
  );
}

// The folder agent's capabilities, one toggle per tool (see docs/dev/agent.md).
const AGENT_PERM_ROWS = [
  ["list", ListIcon, "List pages",
   "See the folder's page titles, labels and metadata"],
  ["read", BookIcon, "Read papers & notes",
   "Read a paper's text plus your highlights and notes"],
  ["search", SearchIcon, "Search PDF text",
   "Full-text search across the folder's PDFs"],
  ["rename", PenIcon, "Rename pages", "Change page titles on request"],
  ["move", FolderIcon, "Move pages",
   "File pages into folders (a new path creates the folder)"],
];

function AssistantSettings({ value }) {
  const shared = "Extracted PDF text is measured in characters. Larger budgets can improve answers but cost more tokens.";
  const limits = [
    [FileTextIcon, "Single paper", "Read from the open paper for one chat message",
      value.chatContextChars, value.setChatContextChars,
      `${shared} When you ask about selected passages, this budget is spent around them (a grounding slice from the start plus text around each selection's page) instead of only the start of the paper.`],
    [PaperIcon, "Metadata extraction", "Read while detecting identifiers and extracting fields",
      value.metaContextChars, value.setMetaContextChars, shared],
    [BookIcon, "Multi-paper total", "Shared evenly by every selected paper",
      value.multiContextChars, value.setMultiContextChars, shared],
  ];

  return (
    <>
      <PaneHead icon={SparklesIcon} title="Assistant">
        Configure chat behavior, context limits, and what the folder agent may do.
      </PaneHead>
      <Section title="Tools">
        <Toggle
          icon={SparklesIcon}
          label="Enable tools"
          hint="Allow chat to use reading, search and organization tools"
          title="Master switch for AI tool use. Off makes both PDF and folder chats plain chat regardless of their per-chat selection; your tool configuration is preserved."
          checked={value.agentEnabled}
          onChange={value.setAgentEnabled}
        />
        <Toggle
          icon={FolderIcon}
          label="Folder chats"
          hint="New folder/library chats start with tools on"
          title="Starting state of the Tools button in library and folder chats. You can override it for the current conversation from the chat header."
          checked={value.folderToolsDefault}
          onChange={value.setFolderToolsDefault}
        />
        <Toggle
          icon={PaperIcon}
          label="PDF chats"
          hint="New paper chats start with tools off"
          title="Starting state of the Tools button in a paper chat. Off keeps PDF chat as a plain context chat until you enable tools from its header."
          checked={value.pdfToolsDefault}
          onChange={value.setPdfToolsDefault}
        />
      </Section>
      <Section title="Tool configuration">
        {AGENT_PERM_ROWS.map(([key, icon, label, hint]) => (
          <Toggle
            key={key} icon={icon} label={label} hint={hint}
            title={`Allowed whenever a chat's Tools switch is on. ${hint}. Whatever tools return is sent to your configured AI provider; every tool call is shown in the reply.`}
            checked={value.agentPerms?.[key] !== false}
            onChange={(v) => value.setAgentPerms((p) => ({ ...p, [key]: v }))}
          />
        ))}
        <Row icon={RefreshIcon} label="Tool rounds"
          hint="AI ↔ tool round-trips per message"
          title="Each round-trip lets the model issue more tool calls. This is a runaway guard — actual work is separately capped at 200 changes per message.">
          <UnitInput value={value.toolRounds} unit="rounds" min={1}
            onCommit={(raw) => {
              const n = Number.parseInt(raw, 10);
              if (Number.isFinite(n)) value.setToolRounds(Math.max(1, Math.min(100, n)));
            }} />
        </Row>
        <Row icon={BookIcon} label="Read window"
          hint={`Document text per read tool call · ${approxPages(value.agentReadChars)}`}
          title="The most extracted PDF text one read_page tool call may return. The agent reads a long paper in windows of this size, continuing where the last call stopped — a larger window means fewer calls but more tokens per message.">
          <CharSlider value={value.agentReadChars} onChange={value.setAgentReadChars} />
        </Row>
      </Section>
      <Section title="Chat">
        <Toggle
          icon={RectSelectIcon}
          label="Clear snapshots on click"
          hint="A plain click in the PDF also drops pending snapshots"
          title="A plain click in the PDF clears the quoted text selections under the chat. Turn this on to also drop pending rectangle snapshots with that click — images pasted into the chat are never touched."
          checked={value.chatImgAutoClear}
          onChange={value.setChatImgAutoClear}
        />
      </Section>
      <Section
        title="Context size"
        action={<button className="uiBtn sm" onClick={value.reset} title="Back to 60000 / 6000 / 120000 characters">Reset</button>}
      >
        {limits.map(([icon, label, hint, current, setCurrent, title]) => (
          <Row key={label} icon={icon} label={label} hint={`${hint} · ${approxPages(current)}`}
            title={title}>
            <CharSlider value={current} onChange={setCurrent} />
          </Row>
        ))}
      </Section>
    </>
  );
}

// --- Advanced: logs ---------------------------------------------------------

// Newest-first log list with a Copy button — one rendering for the session
// log and the admin server log. Entries are normalized to {key, timeMs, text}.
function LogBox({ icon, label, description, entries, emptyText, copyStatus, setStatus }) {
  function copy() {
    const text = entries
      .map((entry) => `${new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })} ${entry.text}`)
      .join("\n");
    copyText(text).then((ok) => setStatus(ok ? copyStatus : "Copy failed—copy manually."));
  }
  return (
    <>
      <Row icon={icon} label={label} hint={description}>
        <button className="uiBtn sm" disabled={!entries.length} onClick={copy}>Copy</button>
      </Row>
      <div className="sysLogBox">
        {entries.length ? [...entries].reverse().map((entry) => (
          <div key={entry.key} className="sysLogRow">
            <span className="sysLogTime">{new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })}</span>
            <span className="sysLogMsg">{entry.text}</span>
          </div>
        )) : <div className="sysLogEmpty">{emptyText}</div>}
      </div>
    </>
  );
}

// Admin-only view of the backend in-memory log (GET /api/admin/logs).
// Polls with a seq cursor while the pane is open; secrets are scrubbed
// server-side before entries ever reach the buffer.
function ServerLogBox({ setStatus }) {
  const [entries, setEntries] = React.useState(null); // null = first poll pending
  const [error, setError] = React.useState("");
  const stateRef = React.useRef({ cursor: 0, entries: [] });
  React.useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const data = await apiJson(`${API}/admin/logs?after=${stateRef.current.cursor}`);
        if (!alive) return;
        const fresh = data.entries || [];
        if (fresh.length) {
          stateRef.current.cursor = fresh[fresh.length - 1].seq;
          stateRef.current.entries = [...stateRef.current.entries, ...fresh].slice(-500);
        }
        setEntries([...stateRef.current.entries]);
        setError("");
      } catch (err) {
        if (alive) { setError(err.message); setEntries((prev) => prev || []); }
      }
    }
    poll();
    const timer = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const shown = (entries || []).map((entry) => ({
    key: entry.seq,
    timeMs: entry.t * 1000,
    text: `${entry.level !== "INFO" ? `[${entry.level}] ` : ""}${entry.msg}`,
  }));
  return (
    <LogBox
      icon={ServerIcon}
      label="Server log"
      description="Backend events since startup · secrets masked · admins only"
      entries={shown}
      emptyText={error ? `Server log unavailable: ${error}`
        : entries ? "Nothing logged since the server started."
          : "Loading…"}
      copyStatus="Server log copied."
      setStatus={setStatus}
    />
  );
}

function AdvancedSettings({ value }) {
  return (
    <>
      <PaneHead icon={ActivityIcon} title="Advanced">
        Status surface, tracing and logs — the things worth attaching to a bug report.
      </PaneHead>
      <Section title="Interface">
        <Toggle
          icon={LayoutIcon}
          label="Status bar"
          hint="Pin the latest status message below the tabs"
          title="Status messages appear briefly as a floating pill. Turn this on to keep the latest one visible in a permanent bar below the tabs."
          checked={value.statusBarVisible}
          onChange={value.setStatusBarVisible}
        />
      </Section>
      <Section title="Tracing">
        <Toggle
          icon={BugIcon}
          label="Debug logging"
          hint="Trace reading-position, restore and sync events"
          title="Trace reading-position tracking, restore and sync events into the system log below (and the browser console)."
          checked={value.debugLog}
          onChange={value.setDebugLog}
        />
      </Section>
      <Section title="Logs">
        <LogBox
          icon={TerminalIcon}
          label="System log"
          description="Application events from this browser session"
          entries={value.sysLog.map((entry, index) => ({ key: index, timeMs: entry.t, text: entry.msg }))}
          emptyText="Nothing logged yet this session."
          copyStatus="Log copied."
          setStatus={value.setStatus}
        />
        {value.isAdmin ? <ServerLogBox setStatus={value.setStatus} /> : null}
      </Section>
    </>
  );
}

// --- the dialog -------------------------------------------------------------

export default function SettingsDialog({
  activePane,
  onPaneChange,
  onClose,
  papers,
  notes,
  library,
  ai,
  prompts,
  context,
  search,
  users,
  diagnostics,
}) {
  if (!activePane) return null;
  const pane = PANE_ALIASES[activePane] || activePane;
  // The users pane doubles as every non-admin's own account pane — same
  // component, but it only ever shows their row (see UsersSettings).
  const groups = NAV_GROUPS
    .map(([group, items]) => [
      group,
      items
        .map(([id, label, Icon]) => (id === "users" && !users?.isAdmin ? [id, "You", UserIcon] : [id, label, Icon]))
        .filter(([id]) => id !== "users" || users),
    ])
    .filter(([, items]) => items.length);

  return (
    <div className="reportOverlay" onClick={onClose}>
      <div className="settingsModal" onClick={(event) => event.stopPropagation()}>
        <div className="settingsSidebar">
          <div className="settingsSideTitle"><SettingsIcon size={15} />Settings</div>
          {groups.map(([group, items]) => (
            <React.Fragment key={group}>
              <div className="settingsNavGroup">{group}</div>
              {items.map(([id, label, Icon]) => (
                <button key={id} title={label} onClick={() => onPaneChange(id)}
                  className={`settingsNavBtn ${pane === id ? "active" : ""}`}>
                  <Icon size={15} /><span>{label}</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
        <div className="settingsPane">
          <button className="uiClose uiCloseLg settingsClose" onClick={onClose} title="Close settings" aria-label="Close settings">×</button>
          {pane === "general" ? <GeneralSettings value={papers} /> : null}
          {pane === "viewer" ? <ViewerSettings value={papers} /> : null}
          {pane === "search" ? <SearchSettings value={search} /> : null}
          {pane === "notes" ? <NotesSettings value={notes} /> : null}
          {/* The Display rows moved here from General, but their state lives in
              the `papers` group — pass it through or they render undefined. */}
          {pane === "library" ? (
            <LibrarySettings value={{
              ...library,
              isAdmin: papers.isAdmin,
              refreshQuota: papers.refreshQuota,
              recentThumbs: papers.recentThumbs,
              setRecentThumbs: papers.setRecentThumbs,
              fileLabels: papers.fileLabels,
              setFileLabels: papers.setFileLabels,
            }} />
          ) : null}
          {pane === "ai" ? <AiSettings value={ai} /> : null}
          {pane === "assistant" ? (
            <AssistantSettings value={{
              ...prompts,
              ...context,
            }} />
          ) : null}
          {pane === "prompts" ? <PromptsSettings value={prompts} /> : null}
          {pane === "users" && users ? <UsersSettings value={users} /> : null}
          {pane === "advanced" ? <AdvancedSettings value={diagnostics} /> : null}
        </div>
      </div>
    </div>
  );
}
