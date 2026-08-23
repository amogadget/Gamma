import React from "react";
import { API, apiJson, fmtBytes, copyText } from "./utils";
import { parseFolderTags } from "./libraryUtils";
import { ActionMenu, MenuSelect } from "./menus";
import {
  ActivityIcon,
  BookIcon,
  BugIcon,
  CloudDownloadIcon,
  CornerDownLeftIcon,
  DatabaseIcon,
  ExportIcon,
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
  LayoutIcon,
  ListIcon,
  MessageSquareIcon,
  MicIcon,
  MonitorIcon,
  MoonIcon,
  MoveVerticalIcon,
  PaperIcon,
  PenIcon,
  PlusIcon,
  RectSelectIcon,
  RefreshIcon,
  ScissorsIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  SunIcon,
  TerminalIcon,
  Trash2Icon,
  TypeIcon,
  UserIcon,
  UsersIcon,
} from "./icons";

// Seven panes in four groups. Each pane is a stack of Sections, each Section a
// stack of Rows — icon · label · one short hint · control. The paragraph that
// used to sit under every label now lives in the row's `title`, so a pane scans
// as a column of pictures and still explains itself on hover.
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
  ]],
  ["Account", [
    ["users", "Users", UsersIcon], // relabelled "You" for non-admins (see SettingsDialog)
    ["advanced", "Advanced", ActivityIcon],
  ]],
];
// Older entry points (and anything that remembered a pane id) still resolve.
const PANE_ALIASES = {
  papers: "general",
  prompts: "assistant", context: "assistant",
  diagnostics: "advanced", account: "users",
};

// --- pane primitives --------------------------------------------------------

function PaneHead({ icon: Icon, title, children }) {
  return (
    <div className="setHead">
      <span className="setHeadIcon"><Icon size={17} /></span>
      <span className="settingText">
        <span className="settingsPaneTitle">{title}</span>
        {children ? <span className="settingsPaneHint">{children}</span> : null}
      </span>
    </div>
  );
}

function Section({ title, action, children }) {
  return (
    <>
      <div className="setSection">
        <span className="setSectionLabel">{title}</span>
        <span className="setSectionRule" />
        {action}
      </div>
      {children}
    </>
  );
}

// `title` is the long explanation — deliberately not rendered, only hovered.
// Rows are plain containers: the control on the right is the only click target,
// so a stray click on the label or hint never flips a setting.
function Row({ icon: Icon, label, hint, title, children }) {
  return (
    <div className="settingRow setRow" title={title}>
      <span className="setIcon">{Icon ? <Icon size={15} /> : null}</span>
      <span className="settingText">
        <span className="settingLabel">{label}</span>
        {hint ? <span className="settingDesc">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label, ...row }) {
  return (
    <Row label={label} {...row}>
      <span className="switch">
        <input
          type="checkbox" checked={checked} aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switchTrack" />
      </span>
    </Row>
  );
}

// Joined pill buttons for a single mutually-exclusive choice.
// `options` are [value, label, Icon, tooltip].
function Segmented({ value, onChange, options }) {
  return (
    <span className="segGroup">
      {options.map(([val, label, Icon, tip]) => (
        <button
          key={val} type="button" title={tip || label}
          className={`uiBtn sm ${value === val ? "on" : ""}`}
          onClick={() => onChange(val)}
        >
          {Icon ? <Icon size={13} /> : null}{label}
        </button>
      ))}
    </span>
  );
}

// Centered popup dialog opened from inside the settings modal — same shape as
// the PDF export dialog (reportModal), stacked above the settings overlay.
// Every editor dialog is composed the same way: SubDialog › .settingsForm ›
// Step (numbered stages, for flows) or Field (label + hint + one control),
// closed by a .reportModalBtns footer.
function SubDialog({ title, onClose, children }) {
  return (
    <div className="reportOverlay subDialog" onClick={onClose}>
      <div className="reportModal" onClick={(event) => event.stopPropagation()}>
        <div className="reportModalTitle">{title}</div>
        {children}
      </div>
    </div>
  );
}

// Numbered stage of a dialog flow (the add/edit-key wizard).
function Step({ n, title, hint, children }) {
  return (
    <div className="setStep">
      <div className="setStepHead">
        <span className="setStepNum">{n}</span>
        <span className="settingText">
          <span className="setStepTitle">{title}</span>
          {hint ? <span className="settingDesc">{hint}</span> : null}
        </span>
      </div>
      <div className="setStepBody">{children}</div>
    </div>
  );
}

// One labeled control: bold-ish caption, muted hint after it, control below.
function Field({ label, hint, children }) {
  return (
    <label className="setField">
      <span className="setFieldLabel">
        {label}
        {hint ? <span className="settingDesc"> — {hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

// Number input with a fixed unit suffix, so "MB" never has to live in the
// label text. Empty string means "inherit" wherever the caller says so.
function UnitInput({ value, onChange, unit, placeholder, min, onEnter }) {
  return (
    <span className="unitInput">
      <input
        className="aiKeyInput" type="number" min={min}
        placeholder={placeholder} value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onEnter ? (event) => { if (event.key === "Enter") onEnter(); } : undefined}
      />
      <span className="unitSuffix">{unit}</span>
    </span>
  );
}

// Character budgets span 100 … 1 000 000, so the slider is log-scaled and snaps
// to round numbers; the box next to it still accepts any exact value.
const SLIDER_MIN = 100, SLIDER_MAX = 1000000, SLIDER_SPAN = Math.log(SLIDER_MAX / SLIDER_MIN);
const toSlider = (v) => Math.round((1000 * Math.log(Math.max(SLIDER_MIN, v) / SLIDER_MIN)) / SLIDER_SPAN);
const fromSlider = (s) => {
  const raw = SLIDER_MIN * Math.exp((s / 1000) * SLIDER_SPAN);
  const step = raw < 10000 ? 100 : raw < 100000 ? 1000 : 10000;
  return Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(raw / step) * step));
};

function CharSlider({ value, onChange }) {
  return (
    <span className="setSlider">
      <input
        type="range" min="0" max="1000" step="1" className="setRange"
        value={toSlider(value)}
        onChange={(event) => onChange(fromSlider(Number(event.target.value)))}
      />
      <input
        className="aiKeyInput setNum" type="number" min={SLIDER_MIN} max={SLIDER_MAX} step="1000"
        value={value}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(next)) onChange(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, next)));
        }}
      />
    </span>
  );
}
// ~1800 characters is about one dense page of a paper — enough to make an
// abstract character budget mean something.
const approxPages = (chars) => `≈ ${Math.max(1, Math.round(chars / 1800))} page${chars >= 2700 ? "s" : ""}`;

// Coverage tile: big count, what it counts, and how far along it is.
function Stat({ icon: Icon, label, value, total, title }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  const tone = pct >= 100 ? "ok" : pct < 60 ? "warn" : "";
  return (
    <div className="setStat" title={title}>
      <span className="setStatTop">
        <span className="setStatNum">{value}</span>
        <span className="setStatOf">/ {total}</span>
      </span>
      <span className="setStatLabel"><Icon size={12} />{label}</span>
      <span className="setStatBar"><i className={tone} style={{ width: `${Math.max(pct, 2)}%` }} /></span>
    </div>
  );
}

function Empty({ icon: Icon, children }) {
  return <div className="setEmpty"><Icon size={26} />{children}</div>;
}

// Cloud-drive-style storage meter: thin bar + "used of total" caption.
// quotaMb 0/undefined = unlimited → caption only, no bar (no denominator).
// barOnly renders just the bar (the account popover puts the numbers next to
// the user card instead). Shared by the popover, Users pane, Library.
export function QuotaMeter({ usedBytes, quotaMb, barOnly }) {
  if (usedBytes == null) return null;
  const quotaBytes = (quotaMb || 0) * 1024 * 1024;
  const pct = quotaBytes ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
  const state = pct >= 95 ? " full" : pct >= 80 ? " warn" : "";
  return (
    <span className="quotaMeter">
      {quotaBytes ? (
        <span className="quotaBar">
          <span
            className={`quotaBarFill${state}`}
            style={{ width: `${usedBytes ? Math.max(pct, 2) : 0}%` }}
          />
        </span>
      ) : null}
      {barOnly ? null : (
        <span className="settingDesc">
          {quotaBytes
            ? `${fmtBytes(usedBytes)} of ${fmtBytes(quotaBytes)} used (${Math.round(pct)}%)`
            : `${fmtBytes(usedBytes)} used — no quota`}
        </span>
      )}
    </span>
  );
}

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
            <button className="uiBtn sm" disabled={!dirty} onClick={() => save(key, saveLabel)}>
              Save
            </button>
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
      setSelected(
        (prev) => new Set([...prev].filter((id) => (data.papers || []).some((p) => p.id === id))),
      );
    } catch (err) {
      setError(err.message);
      setPapers((prev) => prev || []);
    }
  }
  React.useEffect(() => {
    refresh();
  }, []);

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
    if (sortMode === "meta")
      arr.sort((a, b) => (a.has_meta ? 1 : 0) - (b.has_meta ? 1 : 0) || byTime(a, b));
    else if (sortMode === "text")
      arr.sort((a, b) => (textOk(a) ? 1 : 0) - (textOk(b) ? 1 : 0) || byTime(a, b));
    else arr.sort(byTime);
    return arr;
  }, [list, sortMode]);

  async function retry(targets) {
    if (!targets.length || busy) return;
    stopRef.current = false;
    let ok = 0,
      failed = 0;
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
    value.setStatus(
      `Metadata: ${ok} fetched${failed ? `, ${failed} failed` : ""}${stopRef.current ? " (stopped)" : ""}.`,
    );
    refresh();
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
                onChange={() =>
                  setSelected(allSelected ? new Set() : new Set(list.map((p) => p.id)))
                }
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
                <span className="metaStatTitle" title={p.title}>
                  {p.title}
                </span>
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
              <span className="metaStatProgress">
                Fetching {busy.done + 1}/{busy.total} — {busy.title}
              </span>
              <button
                className="uiBtn sm"
                onClick={() => {
                  stopRef.current = true;
                }}
              >
                Stop
              </button>
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

// --- AI providers -----------------------------------------------------------

function ProviderForm({ value, onCancel }) {
  const {
    aiKeysForm,
    setAiKeysForm,
    aiKeysInfo,
    aiKeysBusy,
    aiKeysError,
    aiModelCatalog,
    formOauthPending,
    formModels,
    availModels,
    customModel,
    setCustomModel,
    aiProtocolOf,
    isOauthProto,
    startChatGPTAuth,
    loadModelCatalog,
    addCatalogModel,
    removeModel,
    submitAiProvider,
  } = value;
  const oauth = isOauthProto(aiKeysForm.protocol);
  const protocol = aiProtocolOf(aiKeysForm.protocol);

  return (
    <div className="settingsForm">
      <Step n={1} title="Protocol" hint="Pick the API format, not the vendor — most services speak one of these.">
        <MenuSelect
          block label="API protocol"
          value={aiKeysForm.protocol}
          onChange={(protocol) => setAiKeysForm((form) => ({ ...form, protocol }))}
          options={aiKeysInfo.protocols.map((item) => [item.id, item.label])}
        />
      </Step>

      <Step
        n={2}
        title={oauth ? "Sign in with ChatGPT" : "Credentials"}
        hint={oauth
          ? "No API key — usage is billed to your ChatGPT subscription."
          : "Stored on the server, never shown to the browser again."}
      >
        {oauth ? (
          <>
            <ol className="oauthInstructions">
              <li>Open ChatGPT sign-in below and log in.</li>
              <li>It ends on a localhost error page — that is expected.</li>
              <li>Copy the full callback URL from the address bar.</li>
              <li>Paste it below and select Connect.</li>
            </ol>
            <div className="reportModalBtns settingsAlignStart">
              <button className="uiBtn" disabled={aiKeysBusy} onClick={startChatGPTAuth}>
                {aiKeysForm.oauthState ? "Re-open ChatGPT sign-in" : "Open ChatGPT sign-in"}
              </button>
            </div>
            <Field label="Callback URL" hint="the full address the sign-in ended on">
              <input
                className="aiKeyInput" type="text" spellCheck={false}
                placeholder="http://localhost:1455/auth/callback?code=…"
                value={aiKeysForm.oauthCallback || ""}
                onChange={(event) => setAiKeysForm((form) => ({ ...form, oauthCallback: event.target.value }))}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="API key" hint={aiKeysForm.id ? "leave empty to keep the current one" : null}>
              <input
                className="aiKeyInput" type="password" autoComplete="new-password" spellCheck={false}
                placeholder="sk-…"
                value={aiKeysForm.api_key}
                onChange={(event) => setAiKeysForm((form) => ({ ...form, api_key: event.target.value }))}
                onBlur={() => { if (aiKeysForm.api_key?.trim()) loadModelCatalog(); }}
              />
            </Field>
            <Field label="Base URL" hint={`optional — default ${protocol?.default_base_url || ""}`}>
              <input
                className="aiKeyInput" type="text" spellCheck={false}
                placeholder={protocol?.default_base_url || ""}
                value={aiKeysForm.base_url}
                onChange={(event) => setAiKeysForm((form) => ({ ...form, base_url: event.target.value }))}
              />
            </Field>
          </>
        )}
        <Field label="Name" hint={'optional — e.g. "DeepSeek", "work key"'}>
          <input
            className="aiKeyInput" type="text" spellCheck={false}
            value={aiKeysForm.name}
            onChange={(event) => setAiKeysForm((form) => ({ ...form, name: event.target.value }))}
          />
        </Field>
      </Step>

      <Step
        n={3}
        title="Models"
        hint={formModels.length
          ? "Offered in the chat model menu."
          : `None picked yet — the chat menu falls back to ${protocol?.default_model || "the provider default"}.`}
      >
        {formModels.length ? (
          <div className="aiModelChips">
            {formModels.map((model) => (
              <span className="categoryTag" key={model}>
                {model}
                <button className="uiClose uiCloseSm" title="Remove model" aria-label={`Remove ${model}`} onClick={() => removeModel(model)}>×</button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="aiProvPwForm">
          <input
            id="chatgpt-oauth-cb-input"
            className="aiKeyInput"
            type="text"
            spellCheck={false}
            list="aiModelSuggestions"
            placeholder={aiModelCatalog?.loading
              ? "Add a model — loading the provider list…"
              : availModels.length
                ? `Add a model — type or pick (${availModels.length} available), Enter to add`
                : "Add a model — Enter to add"}
            value={customModel}
            onChange={(event) => {
              const next = event.target.value;
              const inputType = event.nativeEvent?.inputType;
              if ((!inputType || inputType === "insertReplacementText") && availModels.includes(next)) {
                addCatalogModel(next);
                setCustomModel("");
              } else {
                setCustomModel(next);
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (customModel.trim()) {
                addCatalogModel(customModel.trim());
                setCustomModel("");
              }
            }}
          />
          <datalist id="aiModelSuggestions">
            {availModels.map((model) => <option key={model} value={model} />)}
          </datalist>
          <button
            className="uiBtn sm"
            disabled={!!aiModelCatalog?.loading || formOauthPending}
            title={formOauthPending ? "Connect with ChatGPT first" : "Fetch the models available to this credential"}
            onClick={loadModelCatalog}
          >
            {aiModelCatalog?.loading
              ? <><span className="transferSpin inline" /> fetching…</>
              : aiModelCatalog?.models
                ? <><RefreshIcon size={12} /> {aiModelCatalog.models.length} usable</>
                : <><RefreshIcon size={12} /> Fetch</>}
          </button>
        </div>
        {aiModelCatalog?.error ? (
          <div className="reportModalHint settingsNoMargin">
            {aiModelCatalog.error}{" "}
            <button className="searchToggle" title="Retry loading the model list" onClick={loadModelCatalog}><RefreshIcon size={12} /></button>
          </div>
        ) : null}
      </Step>

      {aiKeysError ? <div className="settingsPaneHint aiKeysError">{aiKeysError}</div> : null}
      <div className="reportModalBtns">
        <button className="uiBtn" onClick={onCancel}>Cancel</button>
        <button className="uiBtn primary" disabled={aiKeysBusy} onClick={submitAiProvider}>
          {aiKeysBusy
            ? "Saving…"
            : oauth
              ? (aiKeysForm.oauthCallback || "").trim() || !aiKeysForm.id
                ? "Connect"
                : "Save changes"
              : aiKeysForm.id
                ? "Save changes"
                : "Add key"}
        </button>
      </div>
    </div>
  );
}

function AiSettings({ value }) {
  const closeKeyForm = () => { value.setAiKeysForm(null); value.setAiKeysError(""); };
  const activeKeyId = value.aiKeysInfo?.providers.some((item) => item.id === value.aiProvider)
    ? value.aiProvider
    : value.aiKeysInfo?.providers[0]?.id;
  const canEdit = value.aiKeysInfo?.can_edit;
  const providers = value.aiKeysInfo?.providers || [];
  return (
    <>
      <PaneHead icon={KeyIcon} title="Providers">
        Your own API keys, stored on the server and never sent back to the browser.
      </PaneHead>
      {!value.aiKeysInfo && !value.aiKeysError ? <Empty icon={KeyIcon}>Loading…</Empty> : null}
      {value.aiKeysInfo ? (
        <>
          {providers.length === 0 && !value.aiKeysForm ? (
            <Empty icon={KeyIcon}>
              {canEdit
                ? "No keys yet — add one to enable chat, metadata extraction and citations."
                : "Guest accounts cannot store API keys. Ask the admin for an account."}
            </Empty>
          ) : null}
          {providers.length ? <Section title={providers.length > 1 ? "Keys · pick the one AI requests use" : "Keys"} /> : null}
          {providers.map((provider) => {
            const protocol = value.aiProtocolOf(provider.protocol);
            const test = value.aiKeyTests?.[provider.id];
            const oauth = value.isOauthProto(provider.protocol);
            const active = activeKeyId === provider.id;
            return (
              <label key={provider.id} className={`aiProvRow aiProvSelectable ${active ? "active" : ""}`}>
                {providers.length > 1 ? (
                  <input
                    type="radio"
                    className="aiProvRadio"
                    name="activeAiKey"
                    checked={active}
                    onChange={() => value.setAiProvider(provider.id)}
                    title="Use this key for AI requests"
                  />
                ) : null}
                <span className={`aiProvAvatar ${active ? "active" : ""}`}>
                  {oauth ? <SparklesIcon size={15} /> : <KeyIcon size={15} />}
                </span>
                <span className="aiProvMeta">
                  <span className="aiProvName">
                    {provider.name || protocol?.label || provider.protocol}
                    {active ? <span className="aiProvActiveBadge">in use</span> : null}
                  </span>
                  <span className="aiProvDesc">
                    {oauth
                      ? `${provider.oauth_connected ? `signed in${provider.account ? ` as ${provider.account}` : ""}` : "not connected"} · ChatGPT subscription`
                      : `key ${provider.key_hint || "set"} · ${protocol?.label || provider.protocol}`}
                    {provider.base_url ? ` · ${provider.base_url}` : ""}
                  </span>
                  <span className="aiProvDesc aiProvModels">
                    {(parseFolderTags(provider.models).length
                      ? parseFolderTags(provider.models)
                      : [protocol?.default_model || "provider default"]
                    ).map((model) => (
                      <span className="categoryTag" key={model}>
                        {model}
                      </span>
                    ))}
                  </span>
                  {test ? (
                    <span className={`aiProvDesc ${test.busy ? "" : test.ok ? "aiTestOk" : "aiKeysError"}`}>
                      {test.busy
                        ? "Testing…"
                        : test.ok
                          ? `✓ working · ${test.model} · ${(test.latency_ms / 1000).toFixed(1)}s`
                          : `✗ ${test.error}`}
                    </span>
                  ) : null}
                </span>
                {canEdit ? (
                  <span className="aiProvActions">
                    <button className="uiBtn sm" disabled={value.aiKeysBusy || test?.busy}
                      title="Send a tiny AI request through this credential to check it still works"
                      onClick={() => value.testAiProvider(provider)}>
                      Test
                    </button>
                    <button className="uiBtn sm iconSq" disabled={value.aiKeysBusy} title="Edit this key"
                      aria-label="Edit key" onClick={() => value.startEditAiProvider(provider)}>
                      <PenIcon size={13} />
                    </button>
                    <button className="uiBtn sm iconSq danger" disabled={value.aiKeysBusy} title="Remove this key"
                      aria-label="Remove key" onClick={() => value.deleteAiProvider(provider)}>
                      <Trash2Icon size={13} />
                    </button>
                  </span>
                ) : null}
              </label>
            );
          })}
          {canEdit ? (
            <div className="reportModalBtns settingsAlignStart">
              <button className="uiBtn primary" onClick={value.startAddAiProvider}>+ Add key</button>
            </div>
          ) : null}
          {value.aiKeysForm ? (
            <SubDialog
              title={value.aiKeysForm.id ? "Edit key" : "Add key"}
              onClose={closeKeyForm}
            >
              <ProviderForm value={value} onCancel={closeKeyForm} />
            </SubDialog>
          ) : null}
        </>
      ) : null}
      {!value.aiKeysForm && value.aiKeysError ? (
        <div className="settingsPaneHint aiKeysError">{value.aiKeysError}</div>
      ) : null}
    </>
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

function AssistantSettings({ value }) {
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
  ];
  // A stored "" means "use the default", so the effective saved text is the
  // custom one or the default — that is what a draft is dirty against.
  const dirty = prompts.some((p) => (p.draft || "").trim() !== (p.saved || p.defaultValue || "").trim());

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
        Which model runs each AI job, how much of a paper it sees, and what it is told.
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
        <Toggle
          icon={BookIcon}
          label="Read papers & notes"
          hint="The folder chat may list, read and search your papers"
          title="Lets the home/folder chat list the folder's pages, read a paper's extracted text plus your highlights and notes, and full-text-search the folder's PDFs — e.g. to compare papers or write a summary. Content is sent to your configured AI provider."
          checked={value.agentRead}
          onChange={value.setAgentRead}
        />
        <Toggle
          icon={FolderIcon}
          label="Organize files"
          hint="The folder chat may rename pages and move them between folders"
          title="Lets the home/folder chat rename pages and file them into folders on request. It can never delete anything or edit your notes; every change is shown in the reply. Turn both permissions off for a plain chat."
          checked={value.agentWrite}
          onChange={value.setAgentWrite}
        />
        <Row icon={RefreshIcon} label="Tool rounds"
          hint="AI ↔ tool round-trips per message"
          title="Each round-trip lets the model issue more tool calls. This is a runaway guard — actual work is separately capped at 200 changes per message.">
          <UnitInput value={value.toolRounds} unit="rounds" min={1}
            onChange={(raw) => {
              const n = Number.parseInt(raw, 10);
              if (Number.isFinite(n)) value.setToolRounds(Math.max(1, Math.min(100, n)));
            }} />
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

// --- Advanced: logs ---------------------------------------------------------

// Newest-first log list with a Copy button — one rendering for the session
// log and the admin server log. Entries are normalized to {key, timeMs, text}.
function LogBox({ icon, label, description, entries, emptyText, copyStatus, setStatus }) {
  function copy() {
    const text = entries
      .map(
        (entry) =>
          `${new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })} ${entry.text}`,
      )
      .join("\n");
    copyText(text).then((ok) => setStatus(ok ? copyStatus : "Copy failed—copy manually."));
  }
  return (
    <>
      <Row icon={icon} label={label} hint={description}>
        <button className="uiBtn sm" disabled={!entries.length} onClick={copy}>Copy</button>
      </Row>
      <div className="sysLogBox">
        {entries.length ? (
          [...entries].reverse().map((entry) => (
            <div key={entry.key} className="sysLogRow">
              <span className="sysLogTime">
                {new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className="sysLogMsg">{entry.text}</span>
            </div>
          ))
        ) : (
          <div className="sysLogEmpty">{emptyText}</div>
        )}
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
        if (alive) {
          setError(err.message);
          setEntries((prev) => prev || []);
        }
      }
    }
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
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
      emptyText={
        error
          ? `Server log unavailable: ${error}`
          : entries
            ? "Nothing logged since the server started."
            : "Loading…"
      }
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

// --- Users / Account --------------------------------------------------------

// Settings → Users: the GUI for /api/admin/users*, plus the backup/restore
// actions for each account (the Data button). One combined editor per account
// — name, password, privilege, storage limits, delete.
//
// Non-admins get this pane too, as "You": a single read-only row for
// themselves with the Data button. /api/admin/* is admin-only, so their row is
// built from the session + /api/quota instead of the accounts listing, and
// there is no editor — the same rule the backend enforces on /api/export and
// /api/import-data (your own account, unless you are an admin).
function UsersSettings({ value }) {
  const { setStatus, confirm, onSelfRenamed, refreshQuota, closeSettings,
          isAdmin, me, isGuest, quotaInfo, exportUserData, importUserData } = value;
  const [info, setInfo] = React.useState(null); // {users, me}
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [edit, setEdit] = React.useState(null); // {original, username, password, is_admin, max_upload_mb, quota_mb}
  const [addForm, setAddForm] = React.useState(null); // {username, password, is_admin}

  const [defaults, setDefaults] = React.useState(null); // {max_upload_mb, quota_mb} server-wide
  React.useEffect(() => {
    if (!isAdmin) {
      refreshQuota?.(); // the self row's storage meter comes from /api/quota
      return;
    }
    apiJson(`${API}/admin/users`).then((d) => setInfo(d)).catch((err) => setError(err.message));
    apiJson(`${API}/admin/settings`).then(setDefaults).catch(() => {});
  }, [isAdmin]);

  const myName = isAdmin ? info?.me : me;
  // /api/quota reports effective limits (overrides already resolved), which is
  // exactly what the self row shows — no "blank = inherit" distinction to make.
  const rows = isAdmin ? (info?.users || []) : [{
    username: me,
    is_guest: isGuest,
    is_admin: false,
    created_at: null,
    used_bytes: quotaInfo?.used_bytes,
    max_upload_mb: quotaInfo?.max_upload_mb ?? null,
    quota_mb: quotaInfo?.quota_mb ?? null,
  }];
  const lastAdmin = (u) => u.is_admin && (info?.users || []).filter((x) => x.is_admin && !x.is_guest).length <= 1;

  // Mutation responses carry the fresh users list but omit used_bytes (the
  // server only stats every account's disk on the GET listing) — carry the
  // last known usage forward. Returns the response, or null after setError.
  async function usersCall(path, method, body) {
    setBusy(true);
    setError("");
    try {
      const d = await apiJson(`${API}/admin/users${path}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      setInfo((prev) => {
        const usage = new Map((prev?.users || []).map((u) => [u.username, u.used_bytes]));
        if (d.renamed) usage.set(d.renamed.to, usage.get(d.renamed.from));
        return {
          ...prev,
          users: d.users.map((u) => (u.used_bytes == null ? { ...u, used_bytes: usage.get(u.username) ?? 0 } : u)),
          me: d.renamed?.from === prev?.me ? d.renamed.to : prev?.me,
        };
      });
      return d;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Export/import report progress in the status pill and the background-tasks
  // popover, and the import confirm box wants the screen — so get out of the
  // settings modal first.
  function runDataAction(fn) {
    closeSettings?.();
    fn();
  }

  // Two separate editors per account: credentials (rename/password/privilege)
  // and storage limits — each its own button and dialog.
  // edit = {kind: "account", original, username, password, is_admin}
  //      | {kind: "storage", original, max_upload_mb, quota_mb}
  function openAccount(u) {
    setError("");
    setAddForm(null);
    setEdit({ kind: "account", original: u, username: u.username, password: "", is_admin: !!u.is_admin });
  }

  function openStorage(u) {
    setError("");
    setAddForm(null);
    setEdit({ kind: "storage", original: u, max_upload_mb: u.max_upload_mb ?? "", quota_mb: u.quota_mb ?? "" });
  }

  // "" = inherit the server default (sent as explicit null), digits = override
  function parseLimit(s) {
    const t = String(s ?? "").trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : NaN;
  }

  async function saveAccount() {
    const u = edit.original;
    const payload = {};
    if (edit.password) payload.password = edit.password;
    if (edit.is_admin !== !!u.is_admin) payload.is_admin = edit.is_admin;
    const newName = (edit.username || "").trim();
    const renaming = newName && newName !== u.username;
    if (!Object.keys(payload).length && !renaming) { setEdit(null); return; }
    if (Object.keys(payload).length) {
      if (!await usersCall(`/${encodeURIComponent(u.username)}`, "PUT", payload)) return;
    }
    if (renaming) {
      const d = await usersCall(`/${encodeURIComponent(u.username)}/rename`, "POST", { new_username: newName });
      if (!d) return;
      if (d.renamed) setStatus(`Renamed ${d.renamed.from} → ${d.renamed.to}. Sessions keep working.`);
      // Renamed yourself? Re-read the session so the whole app re-keys
      // (avatar, per-user prefs, synced tabs all follow the new name).
      if (d.renamed?.from === myName) onSelfRenamed?.();
    } else {
      setStatus(`Updated ${u.username}.`);
    }
    setEdit(null);
  }

  async function saveStorage() {
    const u = edit.original;
    const maxMb = parseLimit(edit.max_upload_mb);
    const quotaMb = parseLimit(edit.quota_mb);
    if (Number.isNaN(maxMb) || Number.isNaN(quotaMb)) {
      setError("Storage limits must be whole numbers of MB, or blank for the server default.");
      return;
    }
    const payload = {};
    if (maxMb !== (u.max_upload_mb ?? null)) payload.max_upload_mb = maxMb;
    if (quotaMb !== (u.quota_mb ?? null)) payload.quota_mb = quotaMb;
    if (Object.keys(payload).length) {
      if (!await usersCall(`/${encodeURIComponent(u.username)}`, "PUT", payload)) return;
      setStatus(`Storage limits updated for ${u.username}.`);
      if (u.username === myName) refreshQuota?.();
    }
    setEdit(null);
  }

  function deleteAccount(u) {
    confirm({
      title: "Delete user",
      message: `Delete "${u.username}" and ALL their data (notes, PDFs, settings)? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        const d = await usersCall(`/${encodeURIComponent(u.username)}`, "DELETE");
        if (!d) return;
        setStatus(d.warning || `Deleted ${u.username}.`);
        setEdit(null);
      },
    });
  }

  async function submitAdd() {
    const f = addForm;
    if (!f?.username.trim() || !f?.password) { setError("Username and password are required."); return; }
    const d = await usersCall("", "POST",
      { username: f.username.trim(), password: f.password, is_admin: !!f.is_admin });
    if (!d) return;
    setStatus(`Created ${f.username.trim()}.`);
    setAddForm(null);
  }

  // Backup/restore, as Export/Import dropdowns on every row. Admins get them
  // on each account; everyone else only ever sees their own row.
  function dataMenus(u) {
    const mine = u.username === myName;
    const who = mine ? "your" : `${u.username}'s`;
    return (
      <>
        <ActionMenu
          label="Export" icon={ExportIcon}
          items={[
            {
              icon: ExportIcon, label: "Everything (.zip)",
              title: `Download a zip backup: ${who} notes databases + every uploaded PDF`,
              onClick: () => runDataAction(() => exportUserData(true, u.username)),
            },
            {
              icon: DatabaseIcon, label: "Database only (.zip)",
              title: "A small zip with just the databases (notes, chats, settings) — no uploaded PDFs",
              onClick: () => runDataAction(() => exportUserData(false, u.username)),
            },
          ]}
        />
        {u.is_guest ? null : (
          <ActionMenu
            label="Import" icon={ImportIcon}
            items={[
              {
                icon: ImportIcon, label: "Restore backup…",
                title: `Restore an exported zip: ${who} notes and settings are replaced by the backup, uploaded files are merged in`,
                onClick: () => runDataAction(() => importUserData("replace", u.username)),
              },
              {
                icon: PlusIcon, label: "Merge in…",
                title: `Add pages from an exported zip that are missing there; everything already in ${mine ? "your" : "that"} account is kept unchanged`,
                onClick: () => runDataAction(() => importUserData("merge", u.username)),
              },
            ]}
          />
        )}
      </>
    );
  }

  const closeEdit = () => { setEdit(null); setError(""); };

  function accountDialog() {
    const u = edit.original;
    return (
      <SubDialog title={`Edit ${u.username}`} onClose={closeEdit}>
        <div className="settingsForm">
          <Field label="Username" hint="renaming keeps sessions and share links working">
            <input
              className="aiKeyInput"
              type="text"
              spellCheck={false}
              value={edit.username}
              onChange={(e) => setEdit((f) => ({ ...f, username: e.target.value }))}
            />
          </Field>
          <Field label="New password" hint="blank keeps the current one">
            <input
              className="aiKeyInput" type="password" autoComplete="new-password"
              value={edit.password}
              onChange={(e) => setEdit((f) => ({ ...f, password: e.target.value }))}
            />
          </Field>
          <label className="uiCheckRow" title={lastAdmin(u) ? "The last admin can't be demoted" : ""}>
            <input
              type="checkbox" checked={edit.is_admin} disabled={lastAdmin(u)}
              onChange={(e) => setEdit((f) => ({ ...f, is_admin: e.target.checked }))}
            />
            <ShieldIcon size={13} /> Admin privilege
          </label>
          {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
          <div className="reportModalBtns">
            {u.username !== myName ? (
              <button className="uiBtn danger" disabled={busy} onClick={() => deleteAccount(u)}>
                <Trash2Icon size={13} /> Delete…
              </button>
            ) : null}
            <button className="uiBtn" onClick={closeEdit}>Cancel</button>
            <button className="uiBtn primary" disabled={busy} onClick={saveAccount}>Save</button>
          </div>
        </div>
      </SubDialog>
    );
  }

  function storageDialog() {
    const u = edit.original;
    // effective quota = this account's override, else the server default
    const effQuota = u.quota_mb ?? defaults?.quota_mb;
    const defUpload = defaults ? `server default (${defaults.max_upload_mb})` : "server default";
    const defQuota = defaults
      ? `server default (${defaults.quota_mb || "unlimited"})`
      : "server default";
    return (
      <SubDialog title={`Storage limits — ${u.username}`} onClose={closeEdit}>
        <div className="settingsForm">
          <QuotaMeter usedBytes={u.used_bytes} quotaMb={effQuota} />
          <Field label="Max upload size" hint="largest single PDF or image · blank inherits">
            <UnitInput
              unit="MB" min={1} placeholder={defUpload}
              value={edit.max_upload_mb}
              onChange={(max_upload_mb) => setEdit((f) => ({ ...f, max_upload_mb }))}
            />
          </Field>
          <Field label="Storage quota" hint="total for all uploads · blank inherits · 0 = unlimited">
            <UnitInput
              unit="MB" min={0} placeholder={defQuota}
              value={edit.quota_mb}
              onChange={(quota_mb) => setEdit((f) => ({ ...f, quota_mb }))}
            />
          </Field>
          {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
          <div className="reportModalBtns">
            <button className="uiBtn" onClick={closeEdit}>Cancel</button>
            <button className="uiBtn primary" disabled={busy} onClick={saveStorage}>Save</button>
          </div>
        </div>
      </SubDialog>
    );
  }

  function userRow(u) {
    return (
      <div key={u.username} className="aiProvRow">
        <span className={`aiProvAvatar ${u.is_admin ? "active" : ""}`}>
          {u.is_admin ? <ShieldIcon size={15} /> : <UserIcon size={15} />}
        </span>
        <span className="aiProvMeta">
          <span className="aiProvName">
            {u.username}
            {u.username === myName ? <span className="uiTag">you</span> : null}
            {u.is_admin ? <span className="uiTag admin">admin</span> : null}
            {u.is_guest ? <span className="uiTag">guest</span> : null}
          </span>
          <span className="aiProvDesc">
            {u.is_guest
              ? "shared demo workspace, resets daily"
              : u.created_at // absent on the self row: non-admins can't list accounts
                ? `since ${new Date(u.created_at).toLocaleDateString()}`
                : "signed in"}
            {u.max_upload_mb != null ? ` · max file ${u.max_upload_mb} MB` : ""}
            {u.quota_mb != null ? (u.quota_mb ? ` · quota ${u.quota_mb} MB` : " · unlimited") : ""}
          </span>
          <QuotaMeter usedBytes={u.used_bytes} quotaMb={u.quota_mb ?? defaults?.quota_mb} />
        </span>
        <span className="aiProvActions">
          {dataMenus(u)}
          {isAdmin ? (
            <>
              <button
                className="uiBtn sm iconSq" disabled={busy}
                title={`Storage limits for ${u.username}`}
                aria-label="Storage limits"
                onClick={() => openStorage(u)}
              >
                <HardDriveIcon size={13} />
              </button>
              {!u.is_guest ? (
                <button
                  className="uiBtn sm iconSq" disabled={busy}
                  title={`Rename ${u.username}, set a password, or grant admin`}
                  aria-label="Edit account"
                  onClick={() => openAccount(u)}
                >
                  <PenIcon size={13} />
                </button>
              ) : null}
            </>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <>
      {isAdmin ? (
        <PaneHead icon={UsersIcon} title="Users">
          Accounts on this server. The last admin can never be demoted or deleted.
        </PaneHead>
      ) : (
        <PaneHead icon={UserIcon} title="You">
          Your account and its storage. Only an admin can rename it or change its limits.
        </PaneHead>
      )}
      {isAdmin && !info && !error ? <Empty icon={UsersIcon}>Loading…</Empty> : null}
      {rows.map(userRow)}
      {edit?.kind === "account" ? accountDialog() : null}
      {edit?.kind === "storage" ? storageDialog() : null}
      {!isAdmin ? null : addForm ? (
        <SubDialog title="Add user" onClose={() => { setAddForm(null); setError(""); }}>
          <div className="settingsForm">
          <Field label="Username" hint="letters, digits, _ . -">
            <input
              className="aiKeyInput" type="text" spellCheck={false} autoFocus
              value={addForm.username}
              onChange={(e) => setAddForm((f) => ({ ...f, username: e.target.value }))}
            />
          </Field>
          <Field label="Password">
            <input
              className="aiKeyInput" type="password" autoComplete="new-password"
              value={addForm.password}
              onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }}
            />
          </Field>
          <label className="uiCheckRow">
            <input
              type="checkbox"
              checked={!!addForm.is_admin}
              onChange={(e) => setAddForm((f) => ({ ...f, is_admin: e.target.checked }))}
            />
            <ShieldIcon size={13} /> Grant the admin privilege
          </label>
          {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
          <div className="reportModalBtns">
            <button
              className="uiBtn"
              onClick={() => {
                setAddForm(null);
                setError("");
              }}
            >
              Cancel
            </button>
            <button className="uiBtn primary" disabled={busy} onClick={submitAdd}>
              {busy ? "Creating…" : "Create user"}
            </button>
          </div>
          </div>
        </SubDialog>
      ) : info ? (
        <div className="reportModalBtns settingsAlignStart">
          <button
            className="uiBtn"
            onClick={() => {
              setError("");
              setEdit(null);
              setAddForm({ username: "", password: "", is_admin: false });
            }}
          >
            + Add user
          </button>
        </div>
      ) : null}
      {error && !edit && !addForm ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
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
          {pane === "users" && users ? <UsersSettings value={users} /> : null}
          {pane === "advanced" ? <AdvancedSettings value={diagnostics} /> : null}
        </div>
      </div>
    </div>
  );
}
