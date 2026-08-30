import React from "react";
import { API, apiJson, fmtBytes, copyText } from "./utils";
import { MenuSelect } from "./menus";
import {
  PaneHead, Section, Row, Toggle, Segmented, UnitInput, CharSlider, approxPages,
  Stat, Empty, QuotaMeter,
} from "./settingsKit";
import { AiSettings } from "./settingsAi";
import { UsersSettings } from "./settingsUsers";
import {
  ActivityIcon,
  BookIcon,
  BugIcon,
  CloudDownloadIcon,
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
  LayoutIcon,
  ListIcon,
  MessageSquareIcon,
  MicIcon,
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
    ["ai", "Providers", KeyIcon],
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

function GeneralSettings({ value }) {
  return (
    <>
      <PaneHead icon={SettingsIcon} title="General">
        Appearance and paper preferences — saved in this browser.
      </PaneHead>
      <Section title="Appearance">
        <Row
          icon={value.theme === "dark" ? MoonIcon : value.theme === "light" ? SunIcon : MonitorIcon}
          label="Theme"
          hint="System follows the OS setting"
          title="Light or dark interface. System tracks the operating system's appearance and switches live when it changes."
        >
          <Segmented
            value={value.theme}
            onChange={value.setTheme}
            options={[
              ["system", "System", MonitorIcon, "Follow the OS light/dark setting"],
              ["light", "Light", SunIcon, "Always light"],
              ["dark", "Dark", MoonIcon, "Always dark"],
            ]}
          />
        </Row>
        <Toggle
          icon={MoonIcon}
          label="Flip page colors"
          hint="Dark PDF pages — light text on a dark background"
          title="Render PDF pages inverted for reading in the dark. Display-only: highlights, exports and the stored file keep their real colors. Figures and photos come out as negatives, so scanned papers may look better with this off."
          checked={value.pdfDarkPage}
          onChange={value.setPdfDarkPage}
        />
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
    </>
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

function LibrarySettings({ value }) {
  return (
    <>
      <PaneHead icon={ListIcon} title="Library">
        Storage, and per-paper health of metadata, extracted text and the search index.
      </PaneHead>
      <Section title="Storage">
        <StorageCard />
        {value.isAdmin ? <ServerLimitRows setStatus={value.setStatus} refreshQuota={value.refreshQuota} /> : null}
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
      <MetaStatusSection value={value} />
    </>
  );
}

// Library-wide health: per paper, whether metadata resolved, whether the PDF
// yielded extractable text, and whether the search index covers it — with
// batch retry for the metadata lookups. Text and index state come from the FTS
// index, so "unknown" means not visited yet, not broken; Reindex fills it in.
function MetaStatusSection({ value }) {
  const [papers, setPapers] = React.useState(null); // null = loading
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(null); // {done, total, title} during a batch run
  const [sortMode, setSortMode] = React.useState("meta"); // meta | text | updated
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
  React.useEffect(() => { refresh(); }, []);

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
  const missing = list.filter((p) => !p.has_meta);
  const counts = {
    meta: list.filter((p) => p.has_meta).length,
    text: list.filter(textOk).length,
    indexed: list.filter((p) => p.indexed).length,
  };
  // ISO timestamps compare lexicographically; unfinished-first sorts fall back
  // to recency inside each group.
  const sorted = React.useMemo(() => {
    const byTime = (a, b) => (b.updated_at || "").localeCompare(a.updated_at || "");
    const arr = [...list];
    if (sortMode === "meta") arr.sort((a, b) => (a.has_meta ? 1 : 0) - (b.has_meta ? 1 : 0) || byTime(a, b));
    else if (sortMode === "text") arr.sort((a, b) => (textOk(a) ? 1 : 0) - (textOk(b) ? 1 : 0) || byTime(a, b));
    else arr.sort(byTime);
    return arr;
  }, [list, sortMode]);

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
  const allSelected = list.length > 0 && selected.size === list.length;
  // One adaptive primary action instead of three near-identical buttons: a
  // selection wins, otherwise it offers exactly the papers that need work.
  const targets = selected.size ? list.filter((p) => selected.has(p.id)) : missing;

  const cell = (tone, text, title) => (
    <span className={`metaCell ${tone}`} title={title}><i className="setDot" />{text}</span>
  );
  const metaCell = (p) => (
    p.has_meta
      ? cell("ok", p.meta_source === "ai" ? "AI" : p.meta_source || "yes", "Metadata resolved")
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
            label="Sort papers" value={sortMode} onChange={setSortMode}
            options={[
              ["meta", "Missing metadata first"],
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
            <Stat icon={PaperIcon} label="metadata" value={counts.meta} total={list.length}
              title="Papers with a resolved title, authors and BibTeX" />
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
                onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((p) => p.id)))}
                title={allSelected ? "Clear selection" : "Select all"}
              />
              <span>Paper</span>
              <span>Metadata</span>
              <span>Text</span>
              <span>Index</span>
              <span />
            </div>
            {sorted.map((p) => (
              <label key={p.id} className="metaStatRow">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="metaStatTitle" title={p.title}>{p.title}</span>
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
                  : missing.length ? `${missing.length} without metadata` : "Every paper has metadata"}
              </span>
              <button className="uiBtn sm primary" disabled={!targets.length} onClick={() => retry(targets)}>
                <SparklesIcon size={13} />{selected.size ? "Fetch selected" : "Fetch missing"}
              </button>
              <button className="uiBtn sm" disabled={!list.length} onClick={() => retry(list)}
                title="Re-fetch metadata for every paper, including ones that already have it">
                Refetch all
              </button>
            </div>
          )}
        </>
      ) : null}
    </Section>
  );
}

// --- Assistant: models, chat, context budgets, prompts ----------------------

// Which model runs the AI step of metadata lookups (identifier detection +
// extraction from the first pages). Default follows whatever the chat panel
// has selected; a cheap model is usually plenty here.
function MetaModelSelect({ value }) {
  const models = value.aiModels || [];
  const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
  const current = value.metaModel && models.some((m) => m.id === value.metaModel) ? value.metaModel : "";
  return (
    <MenuSelect
      label="Metadata model" value={current} onChange={value.setMetaModel}
      options={[
        ["", "Same as chat"],
        ...models.map((m) => [m.id, multiProvider ? `${m.model} · ${m.provider_name || m.provider}` : m.model]),
      ]}
    />
  );
}

const DICTATION_LANGS = [
  ["", "Auto-detect"], ["en", "English"], ["zh", "中文"], ["ja", "日本語"], ["ko", "한국어"],
  ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["pt", "Português"],
  ["it", "Italiano"], ["ru", "Русский"], ["hi", "हिन्दी"], ["ar", "العربية"],
];

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
  const limits = [
    [FileTextIcon, "Single paper", "Read from the open paper for one chat message",
      value.chatContextChars, value.setChatContextChars],
    [PaperIcon, "Metadata extraction", "Read while detecting identifiers and extracting fields",
      value.metaContextChars, value.setMetaContextChars],
    [BookIcon, "Multi-paper total", "Shared evenly by every selected paper",
      value.multiContextChars, value.setMultiContextChars],
  ];

  return (
    <>
      <PaneHead icon={SparklesIcon} title="Assistant">
        Which model runs each AI job, how much of a paper it sees, and what the folder agent may do.
      </PaneHead>
      <Section title="Models">
        <Row icon={PaperIcon} label="Metadata model"
          hint="Used when metadata has to be read from the PDF"
          title="Model used when metadata has to be AI-extracted from the PDF text (no arXiv id or DOI found). A fast, cheap model works well for this.">
          <MetaModelSelect value={value} />
        </Row>
        <Row icon={MicIcon} label="Dictation model"
          hint="Speech-to-text for the chat mic button"
          title="gpt-4o-transcribe is what ChatGPT dictation uses; it needs an OpenAI-protocol provider key.">
          <MenuSelect
            label="Dictation model" value={value.dictationModel} onChange={value.setDictationModel}
            options={[
              ["gpt-4o-transcribe", "gpt-4o-transcribe"],
              ["gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe"],
              ["whisper-1", "whisper-1"],
            ]}
          />
        </Row>
        <Row icon={GlobeIcon} label="Dictation language"
          hint="Naming the language improves accuracy"
          title="Telling the model the spoken language improves accuracy; auto-detect handles mixed or unlisted languages.">
          <MenuSelect
            label="Dictation language" value={value.dictationLang} onChange={value.setDictationLang}
            options={DICTATION_LANGS}
          />
        </Row>
      </Section>
      <Section title="Folder agent">
        {AGENT_PERM_ROWS.map(([key, icon, label, hint]) => (
          <Toggle
            key={key} icon={icon} label={label} hint={hint}
            title={`What the home/folder chat is allowed to do with the folder you are viewing. ${hint}. Whatever tools return is sent to your configured AI provider; every tool call is shown in the reply. Turn everything off for a plain chat.`}
            checked={value.agentPerms?.[key] !== false}
            onChange={(v) => value.setAgentPerms((p) => ({ ...p, [key]: v }))}
          />
        ))}
        <Row icon={RefreshIcon} label="Tool rounds"
          hint="AI ↔ tool round-trips per message"
          title="Each round-trip lets the model issue more tool calls. This is a runaway guard — actual work is separately capped at 200 changes per message.">
          <UnitInput value={value.toolRounds} unit="rounds" min={1}
            onChange={(raw) => {
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
        action={<button className="uiBtn sm" onClick={value.reset} title="Back to 8000 / 6000 / 18000 characters">Reset</button>}
      >
        {limits.map(([icon, label, hint, current, setCurrent]) => (
          <Row key={label} icon={icon} label={label} hint={`${hint} · ${approxPages(current)}`}
            title="Extracted PDF text is measured in characters. Larger budgets can improve answers but cost more tokens.">
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
          {pane === "library" ? (
            <LibrarySettings value={{ ...library, isAdmin: papers.isAdmin, refreshQuota: papers.refreshQuota }} />
          ) : null}
          {pane === "ai" ? <AiSettings value={ai} /> : null}
          {pane === "assistant" ? (
            <AssistantSettings value={{
              ...prompts,
              ...context,
              metaModel: papers.metaModel,
              setMetaModel: papers.setMetaModel,
              aiModels: papers.aiModels,
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
