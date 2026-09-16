import React from "react";
import { API, apiJson, fmtBytes, isUnverifiedPaperMeta, metaSourceInfo, getCurrentWorkspace } from "./utils";
import { MenuSelect } from "./menus";
import {
  PaneHead, Section, Row, Toggle, Segmented, ToggleGroup, UnitInput, CharSlider, approxPages,
  Stat, Empty, QuotaMeter, LogBox, SettingsDraftContext, useSettingsDraft,
} from "./settingsKit";
import { LibraryDisplaySettings } from "./settingsLibraryDisplay";
import { AppearanceSettings } from "./settingsAppearance";
import { AiSettings } from "./settingsAi";
import { IntegrationSettings } from "./settingsIntegrations";
import { UsersSettings } from "./settingsUsers";
import { WorkspacesSettings } from "./settingsWorkspace";
import { WorkspaceBackups } from "./settingsBackups";
import { ServerSettings } from "./settingsServer";
import { permissionPreset, presetPermissions } from "./chatSettings";
import { resolveSettingsPane, searchSettings } from "./settingsNavigation";
import { TRANSLATE_LANGS } from "./prefs";
import {
  ActivityIcon,
  BookIcon,
  BugIcon,
  CloudDownloadIcon,
  ContrastIcon,
  DatabaseIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  HardDriveIcon,
  HighlightIcon,
  HomeIcon,
  LanguagesIcon,
  ListIcon,
  MessageSquareIcon,
  OutlineIcon,
  PaperIcon,
  PenIcon,
  PencilIcon,
  RectSelectIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SparklesIcon,
  TerminalIcon,
  TypeIcon,
  UserIcon,
  UsersIcon,
} from "./icons";

// Everyday preferences and management tasks have separate navigation.
const PREFERENCE_NAV = [
  ["appearance", "Appearance", ContrastIcon],
  ["reading", "Reading & editing", BookIcon],
  ["library", "Library", ListIcon],
  ["ai", "AI", SparklesIcon],
  ["account", "Account", UserIcon],
];
const MANAGEMENT_NAV = [
  ["workspaces", "Manage workspaces", UsersIcon],
  ["maintenance", "Library maintenance", DatabaseIcon],
  ["server", "Administration", ServerIcon],
  ["diagnostics", "Diagnostics", ActivityIcon],
];

const AI_NAV = [
  ["ai", "Connections & models", SparklesIcon],
  ["assistant", "Assistant", MessageSquareIcon],
  ["ai-advanced", "Advanced", ActivityIcon],
  ["prompts", "Prompts", TypeIcon],
  ["integrations", "External assistants", GlobeIcon],
];

// --- Editor: notes + search + PDF viewer -----------------------------------

function ViewerSettings({ value }) {
  return (
    <>

      <Section title="PDF viewer">
        <Row
          icon={HighlightIcon}
          label="Imported annotations"
          hint="Annotations become Gamma highlights. Removing originals also rewrites the stored PDF."
          title={"Highlights, notes and rectangles saved inside a PDF file (a Gamma export, SumatraPDF, Acrobat…) are imported as regular highlights. This controls the embedded originals so they don't render twice: Hide leaves the file untouched, Strip removes them from the stored PDF on import."}
        >
          <MenuSelect label="Imported annotations" value={value.embAnnots} onChange={value.setEmbAnnots}
            options={[["hide", "Keep PDF unchanged"], ["strip", "Remove originals after import"]]} />
        </Row>
      </Section>
      <Section title="Handwriting">
        <Toggle
          icon={PenIcon}
          label="Stylus draws right away"
          hint="A pen writes without opening the tools first"
          title="With a stylus (Apple Pencil, Surface Pen, Wacom…), touching the page draws with the pen tool even when the handwriting tools are closed. Fingers and the mouse still select text. Turn off if your stylus keeps leaving marks while you navigate."
          checked={value.inkAutoPen}
          onChange={value.setInkAutoPen}
        />
        <Toggle
          icon={HighlightIcon}
          label="Fingers never draw"
          hint="Touch scrolls and zooms; only a stylus or mouse draws"
          title="With the handwriting tools open, a finger on the page keeps scrolling and pinch-zooming instead of drawing. Turn off on a device without a stylus to draw with a finger. Defaults on for touch screens."
          checked={value.inkPenOnly}
          onChange={value.setInkPenOnly}
        />
        <Toggle
          icon={ActivityIcon}
          label="Pressure-sensitive strokes"
          hint="Pen strokes thicken with pressure"
          title="Use the stylus pressure for stroke width, like ink on paper. Off gives even strokes. Mouse and finger strokes are always even."
          checked={value.inkPressure}
          onChange={value.setInkPressure}
        />
      </Section>
      <Section title="Translation">
        <Toggle
          icon={LanguagesIcon}
          label="Show translation shortcut"
          hint="Show the viewer button; translation only runs when you ask"
          title="Show the translate button in the PDF viewer. Click translates the current page (or shows/hides an existing translation); right-click or long-press opens the options, including translating the whole document. Nothing translates until you ask."
          checked={value.translateEnabled}
          onChange={value.setTranslateEnabled}
        />
        <Row
          icon={GlobeIcon}
          label="Translate into"
          hint="Language for the viewer's translated view"
          title="The translated view (the languages button in the PDF viewer's zoom column) redraws each paragraph in this language in place — figures and layout stay put, and holding Alt peeks at the original. Paragraph translations are cached per language and model, so re-reading a page is free."
        >
          <MenuSelect
            label="Translation language"
            value={value.translateLang}
            onChange={value.setTranslateLang}
            options={TRANSLATE_LANGS}
          />
        </Row>
        <p className="setNotice">Translation models and performance options are in AI settings.</p>
      </Section>
    </>
  );
}

function TranslationModels({ value, advanced = false }) {
  return <>
        {!advanced ? <Row
          icon={SparklesIcon}
          label="Translation model"
          hint="Used when translating pages"
          title="Model used to translate page text. Translation is a bulk job — a fast, cheap model usually reads fine and costs much less than the chat model."
        >
          <TranslateModelSelect value={value} />
        </Row> : null}
        {advanced ? <>
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
          hint="Translation calls in flight at once (1–32)"
          title="A page is translated in small chunks, this many at a time; a whole-document job streams chunks across pages and never exceeds it. Higher is faster until your provider's rate limit pushes back."
        >
          <UnitInput value={value.translateParallel} unit="calls" min={1}
            onCommit={(raw) => {
              const n = Number.parseInt(raw, 10);
              if (Number.isFinite(n)) value.setTranslateParallel(Math.max(1, Math.min(32, n)));
            }} />
        </Row>
        </> : null}
  </>;
}

// Same shape as MetaModelSelect below: "" = follow the chat model, stale
// picks fall back.
function TranslateModelSelect({ value }) {
  const models = value.aiModels || [];
  const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
  const current = value.translateModel && models.some((m) => m.id === value.translateModel) ? value.translateModel : "";
  return (
    <MenuSelect
      label="Translation model" value={current} onChange={value.setTranslateModel}
      options={[
        ["", `Same as chat: ${value.chatModelName || "provider default"}`],
        ...models.map((m) => [m.id, multiProvider ? `${m.model} · ${m.provider_name || m.provider}` : m.model]),
      ]}
    />
  );
}

function SearchSettings({ value }) {
  return (
    <>

      <Section title="Search - expand results automatically">
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
          label="On a page"
          hint="Off: search opens as a compact browser-style find bar"
          title="On a page, Ctrl+F defaults to the compact find bar (match counter and next/previous only). Turn on to open with the full grouped result lists instead."
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

      <Section title="Notes">
        <Row icon={CornerDownLeftIcon} label="Enter key"
          hint={value.enterNewNote ? "Shift+Enter inserts a new line" : "Shift+Enter creates a new note"}>
          <Segmented value={value.enterNewNote ? "note" : "line"}
            onChange={(choice) => value.setEnterNewNote(choice === "note")}
            options={[["note", "New note"], ["line", "New line"]]} />
        </Row>
      </Section>
    </>
  );
}

// Kick off a full search-index rebuild (the Library pane's Index section).
async function requestReindex(setStatus, scheduledSuffix, wakeTasks) {
  try {
    const result = await apiJson(`${API}/search-reindex`, { method: "POST" });
    if (result.scheduled || result.busy) wakeTasks?.();
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
function LibrarySettings({ value, onManage }) {
  return (
    <>
      <PaneHead icon={ListIcon} title="Library">
        Library display and automatic downloads. Changes apply immediately in this browser.
      </PaneHead>
      <Section title="Display">
        <LibraryDisplaySettings value={value} />
      </Section>
      <Section title="PDFs">
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
      <Row icon={DatabaseIcon} label="Library maintenance" hint="Check metadata, extract text, or rebuild the search index">
        <button className="uiBtn sm" onClick={onManage}>Open maintenance</button>
      </Row>
    </>
  );
}

// Library-wide health: per paper, whether metadata resolved, whether the PDF
// yielded extractable text, and whether the search index covers it — with
// batch retry for the metadata lookups. Text and index state come from the FTS
// index, so "unknown" means not visited yet, not broken; Reindex fills it in.
function MaintenanceSettings({ value }) {
  return <>
    <PaneHead icon={DatabaseIcon} title="Library maintenance">Health and storage for the current workspace. Repairs run in the background.</PaneHead>
      <Section title="Storage">
        <StorageCard />
      </Section>
      <Section title="Index">
        <Row
          icon={RefreshIcon}
          label="PDF text index"
          hint={value.indexTask?.active ? "Rebuilding — progress in the tasks popover" : "Re-extract every paper if results look stale"}
          title="Full-text search reads a per-user index built from the extracted PDF text. Rebuild it when library-wide results look stale or incomplete."
        >
          <button className="uiBtn sm" disabled={value.indexTask?.active} onClick={() => requestReindex(value.setStatus, "in the background.", value.wakeTasks)}>
            {value.indexTask?.active ? "Indexing…" : "Rebuild"}
          </button>
        </Row>
      </Section>
      <MetaStatusSection value={value} />
  </>;
}

function MetaStatusSection({ value }) {
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
      value.wakeTasks?.();
      pollRefresh();
    } catch (err) {
      value.setStatus(`Indexing failed: ${err.message}`);
    }
  }

  const list = papers || [];
  const textOk = (p) => (p.text_chars ?? 0) >= 50; // same threshold as /api/pdf-text-status
  // "Unverified": records nothing tied to their document (AI-extracted
  // papers, unconfirmed identifiers) — the same ones the red "!" flags on the
  // metadata button. Missing metadata and unverified records are what a
  // batch (re)fetch can actually fix.
  const unverifiedPaper = (p) => p.has_meta && isUnverifiedPaperMeta(p.meta_source, p.meta_kind, p.meta_unverified);
  const fetchable = (p) => !p.has_meta || unverifiedPaper(p);
  const noText = (p) => p.text_chars !== null && !textOk(p);
  // Index work: papers with a file the search index doesn't cover yet, holds
  // at an older extractor version, or hasn't visited (text unknown) — the same
  // rule as the per-row index button.
  const needsIndex = (p) => p.doc_id && p.has_file && (!p.indexed || p.index_stale || p.text_chars === null);
  const missing = list.filter((p) => !p.has_meta);
  const unverified = list.filter(unverifiedPaper);
  const needsWork = list.filter(fetchable);
  const toIndex = list.filter(needsIndex);
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
  // Same rule for the index button: the selection's indexable papers, else
  // everything the index is missing or holds stale.
  const indexTargets = selected.size ? list.filter((p) => selected.has(p.id) && p.doc_id && p.has_file) : toIndex;
  const indexing = !!value.indexTask?.active;

  const cell = (tone, text, title) => (
    <span className={`metaCell ${tone}`} title={title}><i className="setDot" />{text}</span>
  );
  const metaCell = (p) => {
    if (!p.has_meta) {
      return p.meta_error ? cell("bad", "failed", p.meta_error) : cell("muted", "none", "No metadata yet");
    }
    const src = metaSourceInfo({ source: p.meta_source, kind: p.meta_kind, unverified: p.meta_unverified });
    if (!src) return cell("ok", "yes", "Metadata resolved");
    return cell(src.warn ? "bad" : p.meta_source === "ai" ? "muted" : "ok", src.short, src.hint);
  };
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
            onClick={() => { requestReindex(value.setStatus, "— text status fills in as it runs.", value.wakeTasks); pollRefresh(); }}>
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
                {needsIndex(p) ? (
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
                  : needsWork.length || toIndex.length
                    ? [missing.length && `${missing.length} missing metadata`,
                       unverified.length && `${unverified.length} unverified (AI)`,
                       toIndex.length && `${toIndex.length} to index`]
                        .filter(Boolean).join(" · ")
                    : "Everything is verified and indexed"}
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
              <button className="uiBtn sm" disabled={!indexTargets.length || indexing}
                onClick={() => indexDocs(indexTargets.map((p) => p.doc_id))}
                title={indexing ? "Indexing is already running — progress in the tasks popover"
                  : selected.size ? "Extract the selected papers' text into the search index"
                    : "Extract only the papers the search index is missing or holds at an older extractor version"}>
                <RefreshIcon size={13} />{indexing ? "Indexing…" : selected.size ? "Reindex selected" : "Reindex needed"}
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
  const discard = () => prompts.forEach((p) => p.setDraft(p.saved || p.defaultValue || ""));
  useSettingsDraft("prompts", dirty, discard);
  return (
    <>
      <PaneHead icon={TypeIcon} title="Custom prompts">Instructions for chat, metadata, citations, and the library agent.</PaneHead>
      <p className="setNotice">Prompts are saved in this browser. Save to apply your edits, or Cancel to discard them.</p>
      <Section
        title="Prompts"
        action={
          <span className="setControlGroup">
            <button className="uiBtn sm" disabled={!dirty} onClick={discard}>Cancel</button>
            <button className={`uiBtn sm ${dirty ? "primary" : ""}`} disabled={!dirty} onClick={value.savePrompts}>
              {dirty ? "Save prompts" : "Saved"}
            </button>
          </span>
        }
      >
        <PromptAccordion items={prompts} />
      </Section>
    </>
  );
}

// The agent's capabilities, one chip per permission (see docs/dev/ai_tools.md).
// [key, icon, label, hint, scopes, short] — scopes says which agent scopes
// offer it ("folder" = library/folder chat, "page" = page chat), short is
// the chip name in the ToggleGroup.
const AGENT_PERM_ROWS = [
  ["list", ListIcon, "List pages",
   "See the folder's page titles, labels and metadata", ["folder"], "List"],
  ["read", BookIcon, "Read pages",
   "Read a page's PDF text plus your highlights and notes", ["folder", "page"], "Read"],
  ["block_read", OutlineIcon, "Read note blocks",
   "Read a page's note outline with block ids", ["folder", "page"], "Blocks"],
  ["search", SearchIcon, "Search",
   "Full-text search across the folder's notes and PDFs", ["folder", "page"], "Search"],
  ["web_search", GlobeIcon, "Search papers online",
   "Look papers up on Crossref and arXiv (e.g. a reference a paper cites)", ["folder", "page"], "Papers"],
  ["web_read", CloudDownloadIcon, "Fetch documents",
   "Read a paper or web page by DOI, arXiv id or URL without adding it to the library", ["folder", "page"], "Fetch"],
  ["rename", PenIcon, "Rename pages", "Change page titles on request", ["folder"], "Rename"],
  ["move", FolderIcon, "Move pages",
   "File pages into folders (a new path creates the folder)", ["folder"], "Move"],
  ["block_edit", PencilIcon, "Edit note blocks",
   "Edit, create and move note blocks on request (never deletes)", ["folder", "page"], "Edit"],
];

// The three chat kinds, each with its own permission map (prefs.js
// CHAT_KINDS): [kind, icon, label, hint, agent scope].
export const CHAT_KIND_ROWS = [
  ["folder", FolderIcon, "Folder chat", "Home and folder views — the library organizer", "folder"],
  ["pdf", FileTextIcon, "PDF chat", "A page with a PDF attached", "page"],
  ["notes", OutlineIcon, "Notes chat", "A page of notes without a PDF", "page"],
];

// One chat kind's tool chips (a ToggleGroup) bound to the stored permission
// map — the Settings pane and the chat header's ⚙ popover render this same
// control over the same map, so a change in one is the change in the other.
export function AgentToolPicker({ kind, perms, setPerms, disabled }) {
  const scope = CHAT_KIND_ROWS.find((r) => r[0] === kind)?.[4] || "page";
  const map = perms?.[kind] || {};
  const rows = AGENT_PERM_ROWS.filter((r) => r[4].includes(scope));
  return (
    <ToggleGroup
      disabled={disabled}
      options={rows.map(([key, Icon, label, hint, , short]) => [key, short, Icon, `${label} — ${hint}`])}
      selected={rows.filter(([key]) => map[key] !== false).map(([key]) => key)}
      onToggle={(key, on) => setPerms((p) => ({ ...p, [kind]: { ...(p?.[kind] || {}), [key]: on } }))}
    />
  );
}

function PermissionSetting({ kind, icon, label, hint, perms, setPerms, disabled }) {
  const [custom, setCustom] = React.useState(false);
  const preset = permissionPreset(kind, perms?.[kind]);
  return <div className="setPermission">
    <Row icon={icon} label={label} hint={hint}>
      <fieldset disabled={disabled} className="setControlGroup">
        <MenuSelect label={`${label} permissions`} value={custom ? "custom" : preset}
          onChange={(next) => {
            setCustom(next === "custom");
            if (next !== "custom") setPerms((previous) => ({ ...previous, [kind]: presetPermissions(kind, next) }));
          }} options={[["read", "Read & search"], ["edit", "Read, search & edit"], ["custom", "Custom"]]} />
      </fieldset>
    </Row>
    {custom || preset === "custom" ? <div className="setPermissionCustom">
      <AgentToolPicker kind={kind} perms={perms} setPerms={setPerms} disabled={disabled} />
    </div> : null}
  </div>;
}

function AssistantSettings({ value, onAdvanced }) {
  const budgets = [value.chatContextChars, value.metaContextChars, value.multiContextChars];
  const contextPreset = budgets.every((n, i) => n === [60000, 6000, 120000][i]) ? "standard"
    : budgets.every((n, i) => n === [120000, 12000, 240000][i]) ? "larger" : "custom";
  return (
    <>
      <Section title="Assistant permissions">
        <Toggle icon={SparklesIcon} label="Allow assistant tools"
          hint="Global switch for reading, searching, and editing in all chats"
          checked={value.agentEnabled} onChange={value.setAgentEnabled} />
        {!value.agentEnabled ? <p className="setNotice">Tools are off in all chats. Your permission choices are kept for when you turn them on again.</p> : null}
        {CHAT_KIND_ROWS.map(([kind, icon, label, hint]) => (
          <PermissionSetting key={kind} kind={kind} icon={icon} label={label} hint={hint}
            perms={value.agentPerms} setPerms={value.setAgentPerms} disabled={!value.agentEnabled} />
        ))}

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
      <Row icon={BookIcon} label="Context budget"
        hint="Larger budgets include more document text and use more tokens">
        <MenuSelect label="Context budget" value={contextPreset}
          onChange={(preset) => {
            if (preset === "custom") { onAdvanced(); return; }
            const factor = preset === "larger" ? 2 : 1;
            value.setChatContextChars(60000 * factor);
            value.setMetaContextChars(6000 * factor);
            value.setMultiContextChars(120000 * factor);
          }} options={[["standard", "Standard"], ["larger", "Larger"], ["custom", "Custom"]]} />
      </Row>
    </>
  );
}

function AdvancedAiSettings({ value, ai, papers }) {
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

  return <>

        <Row icon={ActivityIcon} label="Default reasoning effort" hint="Used by all chats in this browser; leave Default unless your model supports it">
          <MenuSelect label="Default reasoning effort" value={ai.chatEffort} onChange={ai.setChatEffort}
            options={[["", "Default"], ...(ai.aiInfo?.efforts || ["low", "medium", "high"]).map((v) => [v, v])]} />
        </Row>
        <Section title="Tool limits">
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
        <Section title="Translation performance"><TranslationModels value={papers} advanced /></Section>
  </>;
}


// --- Advanced: logs ---------------------------------------------------------

function AdvancedSettings({ value }) {
  return (
    <>
      <PaneHead icon={ActivityIcon} title="Diagnostics">
        Debug logging and events from this browser session.
      </PaneHead>
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
      </Section>
    </>
  );
}

// --- the dialog -------------------------------------------------------------

export default function SettingsDialog({
  activePane, onPaneChange, onClose, papers, notes, library, ai, prompts,
  context, search, users, workspace, backups, server, diagnostics,
}) {
  const [query, setQuery] = React.useState("");
  const [mobileIndex, setMobileIndex] = React.useState(false);
  const [jump, setJump] = React.useState(null);
  const [pending, setPending] = React.useState(null);
  const paneRef = React.useRef(null);
  const modalRef = React.useRef(null);
  const drafts = React.useRef(new Map());
  const available = (id) => {
    if (id === "integrations") return !!users && !users.isGuest;
    if (["account", "users"].includes(id)) return !!users && (id !== "users" || users.isAdmin);
    if (["workspaces", "backups"].includes(id)) return !!workspace;
    if (id === "server") return !!server;
    return true;
  };
  const allNav = [...PREFERENCE_NAV, ...MANAGEMENT_NAV, ...AI_NAV.filter(([id]) => id !== "ai"), ["backups", "Backups", DatabaseIcon], ["users", "Users", UsersIcon]];
  const allowed = allNav.filter(([id]) => available(id));
  const requested = resolveSettingsPane(activePane);
  const pane = allowed.some(([id]) => id === requested) ? requested : "appearance";
  const aiArea = AI_NAV.some(([id]) => id === pane);
  const management = aiArea || ["workspaces", "backups", "server", "users"].includes(pane);
  const manageTitle = aiArea ? "AI settings" : ["workspaces", "backups"].includes(pane) ? "Workspace manager"
    : ["server", "users"].includes(pane) ? "Administration" : allNav.find(([id]) => id === pane)?.[1];
  const managementItems = aiArea ? AI_NAV : ["workspaces", "backups"].includes(pane)
    ? [["workspaces", "Workspaces", UsersIcon], ["backups", "Backups", DatabaseIcon]]
    : ["server", "users"].includes(pane)
      ? [["users", "Users", UsersIcon], ["server", "Server", ServerIcon]]
      : MANAGEMENT_NAV.filter(([id]) => id === pane);
  const guard = (action) => {
    if (drafts.current.size) setPending(() => action);
    else action();
  };
  const navigate = (id, label) => guard(() => {
    setQuery(""); setMobileIndex(false); onPaneChange(id);
    setJump(label ? { label } : null);
    paneRef.current?.scrollTo(0, 0);
  });
  React.useEffect(() => {
    if (!activePane) { setQuery(""); setPending(null); setMobileIndex(false); return; }
    const legacyTarget = { notes: "Enter key", search: "On the home page", viewer: "Imported annotations",
      context: "Single paper" }[activePane];
    if (legacyTarget) setJump({ label: legacyTarget });
  }, [activePane]);
  React.useEffect(() => {
    if (!jump || query || !activePane) return;
    const target = [...(paneRef.current?.querySelectorAll("[data-setting]") || [])]
      .find((element) => element.dataset.setting === jump.label);
    if (!target) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: "instant" });
  }, [jump, pane, query, activePane]);
  // Keep keyboard navigation inside the settings surface; Escape uses the same
  // draft guard as Close and clicking the backdrop.
  React.useEffect(() => {
    if (!activePane) return;
    const previous = document.activeElement;
    modalRef.current?.focus();
    return () => previous?.focus?.();
  }, [!!activePane]);
  if (!activePane) return null;
  const results = searchSettings(query, allowed.map(([id]) => id));
  const aiValue = { ...ai, aiInfo: prompts.aiInfo };
  const paperValue = { ...papers, chatModelName: (ai.aiModels || []).find((m) => m.id === ai.chatModel)?.model };
  const navButton = ([id, label, Icon]) => <button key={id} type="button"
    className={`settingsNavBtn ${pane === id && !query ? "active" : ""}`}
    aria-current={pane === id && !query ? "page" : undefined} onClick={() => navigate(id)}>
    <Icon size={17} /><span>{label}</span>
  </button>;
  return (
    <SettingsDraftContext.Provider value={drafts}>
      <div className="reportOverlay" onClick={() => guard(onClose)}>
        <div className={`settingsModal ${mobileIndex ? "settingsIndexOpen" : ""}`}
          role="dialog" aria-modal="true" aria-label={management ? manageTitle : "Settings"}
          tabIndex={-1} ref={modalRef} onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation(); event.preventDefault();
              if (pending) setPending(null);
              else if (query) setQuery("");
              else guard(onClose);
            }
            if (event.key === "Tab") {
              const targets = [...modalRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
                .filter((el) => el.getClientRects().length && !el.closest("[inert]"));
              const first = targets[0], last = targets.at(-1);
              if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalRef.current)) { event.preventDefault(); first?.focus(); }
            }
          }}>
          <div className="settingsTopbar">
            <button className="uiBtn sm settingsMobileBack" onClick={() => guard(() => { setMobileIndex(true); setQuery(""); })}>Back</button>
            <span className="settingsTopTitle">{management ? manageTitle : "Settings"}</span>
            <div className="settingsSearch">
              <SearchIcon size={16} />
              <input className="aiKeyInput" type="search" aria-label="Search settings" placeholder="Search settings..." value={query}
                onChange={(event) => {
                  const next = event.target.value;
                  guard(() => { setQuery(next); setMobileIndex(false); });
                }} />
              {query ? <button className="uiClose uiCloseSm" aria-label="Clear search" onClick={() => setQuery("")}>×</button> : null}
            </div>
            <button className="uiClose uiCloseLg" onClick={() => guard(onClose)} aria-label="Close settings">×</button>
          </div>
          <div className="settingsBody" inert={pending ? "" : undefined}>
            <nav className="settingsSidebar" aria-label="Settings categories">
              {management ? <>
                <button className="settingsNavBtn" onClick={() => navigate("appearance")}>Back to settings</button>
                <div className="settingsNavGroup">{manageTitle}</div>
                {managementItems.filter(([id]) => available(id)).map(navButton)}
              </> : <>
                {PREFERENCE_NAV.filter(([id]) => available(id)).map(navButton)}
                <div className="settingsNavGroup">Manage</div>
                {MANAGEMENT_NAV.filter(([id]) => available(id)).map(navButton)}
              </>}
            </nav>
            <main className="settingsPane" ref={paneRef} key={pane}>
              {query.trim() ? <>
                <PaneHead icon={SearchIcon} title="Search settings">{results.length} matching settings</PaneHead>
                {results.length ? results.map(({ pane: id, label }) => <button key={`${id}:${label}`} className="uiBtn settingsSearchResult"
                  onClick={() => navigate(id, label)}><span>{label}</span><small>{allNav.find(([key]) => key === id)?.[1]}</small></button>)
                  : <Empty icon={SearchIcon}>No settings found. Try "model", "PDF", or "storage".</Empty>}
              </> : <>
                {pane === "appearance" ? <AppearanceSettings value={papers} diagnostics={diagnostics} /> : null}
                {pane === "reading" ? <>
                  <PaneHead icon={BookIcon} title="Reading & editing">PDF viewing, notes, and search. Changes apply immediately in this browser.</PaneHead>
                  <ViewerSettings value={papers} /><NotesSettings value={notes} /><SearchSettings value={search} />
                  <button className="uiBtn sm settingsInlineLink" onClick={() => navigate("ai", "Translation model")}>Translation models and performance</button>
                </> : null}
                {pane === "library" ? <LibrarySettings value={{ ...papers, ...library }} onManage={() => navigate("maintenance")} /> : null}
                {pane === "maintenance" ? <MaintenanceSettings value={library} /> : null}
                {pane === "ai" ? <>
                  <PaneHead icon={SparklesIcon} title="Connections & models">Connections follow your account. Model choices apply to all chats in this browser.</PaneHead>
                  <AiSettings value={aiValue} taskModels={<TranslationModels value={paperValue} />} />
                </> : null}
                {pane === "assistant" ? <>
                  <PaneHead icon={MessageSquareIcon} title="Assistant">Shared settings for all chats in this browser, including changes from the chat settings shortcut.</PaneHead>
                  <AssistantSettings value={context} onAdvanced={() => navigate("ai-advanced", "Single paper")} />
                </> : null}
                {pane === "ai-advanced" ? <>
                  <PaneHead icon={ActivityIcon} title="Advanced AI settings">Context budgets, tool limits, and translation performance. Saved in this browser.</PaneHead>
                  <AdvancedAiSettings value={context} ai={aiValue} papers={paperValue} />
                </> : null}
                {pane === "prompts" ? <PromptsSettings value={prompts} /> : null}
                {pane === "integrations" ? <IntegrationSettings key={getCurrentWorkspace()} workspaceId={getCurrentWorkspace()} /> : null}
                {pane === "account" ? <UsersSettings value={users} selfOnly /> : null}
                {pane === "users" ? <UsersSettings value={users} /> : null}
                {pane === "workspaces" ? <WorkspacesSettings value={workspace} /> : null}
                {pane === "backups" && backups ? <WorkspaceBackups value={backups} /> : null}
                {pane === "server" ? <ServerSettings value={server} /> : null}
                {pane === "diagnostics" ? <AdvancedSettings value={diagnostics} /> : null}
              </>}
            </main>
          </div>
          {pending ? <div className="settingsUnsaved" role="alertdialog" aria-label="Unsaved changes">
            <span>You have unsaved edits. Keep editing or discard them to continue.</span>
            <button className="uiBtn" autoFocus onClick={() => setPending(null)}>Keep editing</button>
            <button className="uiBtn danger" onClick={() => {
              const action = pending;
              drafts.current.forEach((discard) => discard()); drafts.current.clear();
              setPending(null); action();
            }}>Discard changes</button>
          </div> : null}
        </div>
      </div>
    </SettingsDraftContext.Provider>
  );
}
