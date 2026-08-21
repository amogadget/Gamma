import React from "react";
import { API, apiJson, fmtBytes, copyText } from "./utils";
import { parseFolderTags } from "./libraryUtils";
import {
  ActivityIcon,
  BookIcon,
  DatabaseIcon,
  ExportIcon,
  ImportIcon,
  KeyIcon,
  ListIcon,
  PaperIcon,
  PenIcon,
  SearchIcon,
  SlidersIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
} from "./icons";

const NAV_ITEMS = [
  ["papers", "Paper metadata", PaperIcon],
  ["notes", "Notes", PenIcon],
  ["library", "Library status", ListIcon],
  ["ai", "AI & API keys", KeyIcon],
  ["prompts", "Prompts", SlidersIcon],
  ["context", "AI chat", BookIcon],
  ["search", "Search", SearchIcon],
  ["users", "Users", UsersIcon], // relabelled "Account" for non-admins (see SettingsDialog)
  ["diagnostics", "Diagnostics", ActivityIcon],
];

function PaneIntro({ title, children }) {
  return (
    <>
      <div className="settingsPaneTitle">{title}</div>
      <div className="settingsPaneHint">{children}</div>
    </>
  );
}

// Cloud-drive-style storage meter: thin bar + "used of total" caption.
// quotaMb 0/undefined = unlimited → caption only, no bar (no denominator).
// barOnly renders just the bar (the account popover puts the numbers next to
// the user card instead). Shared by the popover, Users pane, Library status.
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

function SettingToggle({ label, description, checked, onChange }) {
  return (
    <label className="settingRow">
      <span className="settingText">
        <span className="settingLabel">{label}</span>
        <span className="settingDesc">{description}</span>
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switchTrack" />
      </span>
    </label>
  );
}

function PapersSettings({ value }) {
  return (
    <>
      <PaneIntro title="Paper metadata">
        How papers are fetched, stored, and enriched when you open them. These preferences are saved
        in this browser.
      </PaneIntro>
      <SettingToggle
        label="Open-access fallback"
        description="When a publisher PDF is paywalled or refuses to download, load a legal open-access copy instead—usually the arXiv version. A note tells you when the substitute isn't the published version."
        checked={value.oaFallback}
        onChange={value.setOaFallback}
      />
      <SettingToggle
        label="Auto-fetch metadata"
        description="Look up title, authors, venue, and BibTeX the first time a paper opens (arXiv → DOI → AI). Turn this off to fetch only via the refresh button in the metadata popover."
        checked={value.metaAutoFetch}
        onChange={value.setMetaAutoFetch}
      />
      <SettingToggle
        label="Save external PDFs"
        description="Keep a server copy of PDFs opened from a URL, so they load instantly next time and survive dead links."
        checked={value.pdfSaveLocal}
        onChange={value.setPdfSaveLocal}
      />
      <label className="settingRow">
        <span className="settingText">
          <span className="settingLabel">Embedded PDF annotations</span>
          <span className="settingDesc">
            Highlights, notes, and rectangle annotations saved inside a PDF file (a Gamma export,
            SumatraPDF, Acrobat…) are imported as regular highlights — this controls what happens to
            the embedded originals so they don't render twice. "Hide in viewer" leaves the file
            untouched; "Strip from file" removes them from the stored PDF when they're imported.
          </span>
        </span>
        <select
          className="aiKeyInput settingSelect"
          value={value.embAnnots}
          onChange={(e) => value.setEmbAnnots(e.target.value)}
        >
          <option value="hide">Hide in viewer</option>
          <option value="strip">Strip from file</option>
        </select>
      </label>
      <MetaModelRow value={value} />
      {value.isAdmin ? (
        <ServerLimitRows setStatus={value.setStatus} refreshQuota={value.refreshQuota} />
      ) : null}
    </>
  );
}

function NotesSettings({ value }) {
  return (
    <>
      <PaneIntro title="Notes">
        How the note outliner behaves while you write. These preferences are saved in this browser.
      </PaneIntro>
      <SettingToggle
        label="Enter starts a new note"
        description="Logseq-style: Enter creates the next note, Shift+Enter types a line break inside the current one. Turn off to swap them — Enter types line breaks, Shift+Enter starts a new note (the + button under the notes always creates one)."
        checked={value.enterNewNote}
        onChange={value.setEnterNewNote}
      />
      <SettingToggle
        label="Note badges on highlights"
        description="Show a small speech-bubble next to a highlight in the PDF when you've typed a note on it. Click the bubble to jump to the note."
        checked={value.hlNoteBadges}
        onChange={value.setHlNoteBadges}
      />
    </>
  );
}

// Admin-only server-wide default storage limits (users.db via
// /api/admin/settings). Per-account overrides live in the Users dialog.
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
  function row(key, label, desc, min, saveLabel) {
    const parsed = parseInt(draft[key], 10);
    const valid = Number.isFinite(parsed) && parsed >= min;
    const dirty = saved && valid && parsed !== saved[key];
    return (
      <div className="settingRow">
        <span className="settingText">
          <span className="settingLabel">{label}</span>
          <span className="settingDesc">{desc}</span>
        </span>
        {error ? (
          <span className="settingDesc">{error}</span>
        ) : (
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              className="aiKeyInput"
              style={{ width: 84, textAlign: "right" }}
              type="number"
              min={min}
              value={draft[key]}
              disabled={!saved}
              onChange={(e) => setDraft((f) => ({ ...f, [key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) save(key, saveLabel);
              }}
            />
            <button className="uiBtn sm" disabled={!dirty} onClick={() => save(key, saveLabel)}>
              Save
            </button>
          </span>
        )}
      </div>
    );
  }
  return (
    <>
      {row(
        "max_upload_mb",
        "Default maximum upload size (MB)",
        "Server-wide cap on a single uploaded PDF or image. Override per account from Manage users. Admins only.",
        1,
        "Upload limit",
      )}
      {row(
        "quota_mb",
        "Default storage quota (MB)",
        "Total uploads storage per account; 0 = unlimited. Override per account from Manage users. Admins only.",
        0,
        "Storage quota",
      )}
    </>
  );
}

// Everyone sees their own usage against their effective limits (GET /api/quota).
function StorageUsageRow() {
  const [q, setQ] = React.useState(null);
  React.useEffect(() => {
    apiJson(`${API}/quota`)
      .then(setQ)
      .catch(() => {});
  }, []);
  if (!q) return null;
  return (
    <div className="settingRow">
      <span className="settingText">
        <span className="settingLabel">Storage used</span>
        <span className="settingDesc">
          Uploaded PDFs and images on the server. Files up to {q.max_upload_mb} MB each
          {q.quota_mb ? `, ${q.quota_mb} MB total.` : ", no total quota."}
        </span>
      </span>
      <span className="settingQuotaCell">
        <QuotaMeter usedBytes={q.used_bytes} quotaMb={q.quota_mb} />
      </span>
    </div>
  );
}

function LibrarySettings({ value }) {
  return (
    <>
      <PaneIntro title="Library status">
        Per-paper health of your library: metadata, extracted PDF text, and the search index — with
        batch retry for failed or missing metadata lookups.
      </PaneIntro>
      <StorageUsageRow />
      <MetaStatusSection value={value} />
    </>
  );
}

// Which model runs the AI step of metadata lookups (identifier detection +
// extraction from the first pages). Default follows whatever the chat panel
// has selected; a cheap model is usually plenty here.
function MetaModelRow({ value }) {
  const models = value.aiModels || [];
  const multiProvider = new Set(models.map((m) => m.provider)).size > 1;
  const current =
    value.metaModel && models.some((m) => m.id === value.metaModel) ? value.metaModel : "";
  return (
    <label className="settingRow">
      <span className="settingText">
        <span className="settingLabel">Metadata model</span>
        <span className="settingDesc">
          Model used when metadata has to be AI-extracted from the PDF text (no arXiv id or DOI
          found). A fast, cheap model works well for this.
        </span>
      </span>
      <select
        className="aiKeyInput settingSelect"
        value={current}
        onChange={(e) => value.setMetaModel(e.target.value)}
      >
        <option value="">Same as chat model</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {multiProvider ? `${m.model} · ${m.provider_name || m.provider}` : m.model}
          </option>
        ))}
      </select>
    </label>
  );
}

// Kick off a full search-index rebuild. Shared by the library-status pane and
// the Search pane — only the phrasing after the scheduled count differs.
async function requestReindex(setStatus, scheduledSuffix) {
  try {
    const result = await apiJson(`${API}/search-reindex`, { method: "POST" });
    setStatus(
      result.busy
        ? "Indexing is already running—see the tasks popover."
        : result.scheduled
          ? `Re-indexing ${result.scheduled} paper${result.scheduled === 1 ? "" : "s"} ${scheduledSuffix}`
          : "No papers with PDFs to index.",
    );
  } catch (err) {
    setStatus(`Reindex failed: ${err.message}`);
  }
}

// Library-wide health: per paper, whether metadata resolved, whether the PDF
// yielded extractable text, and whether the search index covers it — with
// batch retry (selected / missing / all) for the metadata lookups. Text and
// index state come from the FTS index, so "not indexed" means unknown, not
// broken; the Reindex button fills those in.
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

  const list = React.useMemo(() => papers || [], [papers]);
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

  const reindex = () => requestReindex(value.setStatus, "— text status fills in as it runs.");

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected = list.length > 0 && selected.size === list.length;

  const metaCell = (p) =>
    p.has_meta ? (
      <span className="metaStatOk">✓ {p.meta_source === "ai" ? "AI" : p.meta_source || "yes"}</span>
    ) : p.meta_error ? (
      <span className="metaStatBad" title={p.meta_error}>
        ✗ failed
      </span>
    ) : (
      <span className="metaStatMuted">—</span>
    );
  // Text and index are separate columns: extraction state is only known once
  // the indexer has visited the doc, so an unindexed paper shows "?" here.
  const textCell = (p) =>
    p.text_chars === null ? (
      <span
        className="metaStatMuted"
        title="Unknown until the paper is indexed — Reindex to find out"
      >
        ?
      </span>
    ) : textOk(p) ? (
      <span className="metaStatOk" title={`${p.text_chars.toLocaleString()} characters extracted`}>
        ✓ {p.text_chars >= 1000 ? `${Math.round(p.text_chars / 1000)}k` : p.text_chars}
      </span>
    ) : (
      <span
        className="metaStatBad"
        title={p.has_file ? "No text layer — scanned or image-only?" : "PDF file not on the server"}
      >
        ✗ no text
      </span>
    );
  const indexCell = (p) =>
    p.indexed ? (
      <span className="metaStatOk">✓ indexed</span>
    ) : p.index_stale ? (
      <span
        className="metaStatMuted"
        title="Indexed with an older extractor version — Reindex refreshes it"
      >
        stale
      </span>
    ) : (
      <span className="metaStatMuted" title="Not in the search index yet">
        —
      </span>
    );

  return (
    <>
      <div className="promptSectionHead metaStatHead">
        <span>Papers</span>
        <span className="metaStatActions">
          <select
            className="homeSortSelect"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value)}
            title="Sort papers"
          >
            <option value="meta">Metadata — unfinished first</option>
            <option value="text">PDF text — unfinished first</option>
            <option value="updated">Recently modified</option>
          </select>
          <button
            className="uiBtn sm"
            onClick={reindex}
            title="Re-extract every paper's text into the search index (also fills in the text column)"
          >
            Reindex
          </button>
          <button className="uiBtn sm" onClick={refresh} disabled={!!busy}>
            Refresh
          </button>
        </span>
      </div>
      {papers === null ? <div className="reportModalHint">Loading…</div> : null}
      {error ? <div className="reportModalHint">Status failed: {error}</div> : null}
      {papers !== null && !list.length ? (
        <div className="reportModalHint">No papers yet — open a PDF first.</div>
      ) : null}
      {list.length ? (
        <>
          <div className="metaStatSummary">
            Out of {list.length} paper{list.length === 1 ? "" : "s"}: <b>{counts.meta}</b> with
            metadata · <b>{counts.text}</b> with extracted text · <b>{counts.indexed}</b> indexed
            for search
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
              <span>PDF text</span>
              <span>Index</span>
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
              <button
                className="uiBtn sm"
                disabled={!selected.size}
                onClick={() => retry(list.filter((p) => selected.has(p.id)))}
              >
                Retry selected{selected.size ? ` (${selected.size})` : ""}
              </button>
              <button
                className="uiBtn sm"
                disabled={!missing.length}
                onClick={() => retry(missing)}
              >
                Retry missing ({missing.length})
              </button>
              <button className="uiBtn sm" onClick={() => retry(list)}>
                Retry all ({list.length})
              </button>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

function ProviderForm({ value }) {
  const {
    aiKeysForm,
    setAiKeysForm,
    aiKeysInfo,
    aiKeysBusy,
    aiKeysError,
    setAiKeysError,
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
    <div className="aiProvForm">
      <div className="promptSectionHead">
        <span>{aiKeysForm.id ? "Edit key" : "Add key"}</span>
      </div>
      <select
        className="aiKeyInput"
        value={aiKeysForm.protocol}
        onChange={(event) => setAiKeysForm((form) => ({ ...form, protocol: event.target.value }))}
      >
        {aiKeysInfo.protocols.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>

      {oauth ? (
        <>
          <div className="reportModalHint">
            No API key—usage is billed to your ChatGPT Plus/Pro subscription.
            <ol className="oauthInstructions">
              <li>Open ChatGPT sign-in below and log in in the popup.</li>
              <li>The login ends on a localhost error page; that is expected.</li>
              <li>Copy the full callback URL from the popup's address bar, then close it.</li>
              <li>The form picks it up from the clipboard and connects on its own.</li>
            </ol>
          </div>
          <div className="reportModalBtns settingsAlignStart">
            <button className="uiBtn" disabled={aiKeysBusy} onClick={startChatGPTAuth}>
              {aiKeysForm.oauthState ? "Re-open ChatGPT sign-in" : "Open ChatGPT sign-in"}
            </button>
            {/* Manual fallback for when the popup's close is missed, or the
                browser refuses a clipboard read outside a user gesture. */}
            <button
              className="uiBtn"
              disabled={aiKeysBusy || !aiKeysForm.oauthState}
              title="Read the callback URL from your clipboard"
              onClick={async () => {
                try {
                  const text = ((await navigator.clipboard.readText()) || "").trim();
                  const match = text.match(/https?:\/\/localhost:1455\/auth\/callback[^\s]*/);
                  if (match) {
                    setAiKeysForm((form) => (form ? { ...form, oauthCallback: match[0] } : form));
                    setAiKeysError("");
                  } else {
                    setAiKeysError("Clipboard doesn't look like a localhost:1455 callback URL.");
                  }
                } catch (err) {
                  setAiKeysError(`Clipboard read blocked: ${err.message || err}`);
                }
              }}
            >
              Paste from clipboard
            </button>
          </div>
          {aiKeysForm.oauthWaiting ? (
            <div className="reportModalHint">
              Waiting for the popup… After signing in, the browser will hit an error page — just{" "}
              <b>copy that URL</b> from the popup's address bar and close the popup. This form will
              pick it up automatically.
            </div>
          ) : null}
          <input
            id="chatgpt-oauth-cb-input"
            className="aiKeyInput"
            type="text"
            spellCheck={false}
            placeholder="Callback URL — auto-filled from the clipboard when the popup closes"
            value={aiKeysForm.oauthCallback || ""}
            onChange={(event) =>
              setAiKeysForm((form) => ({ ...form, oauthCallback: event.target.value }))
            }
          />
        </>
      ) : (
        <div className="reportModalHint">
          Pick the API format, not the vendor. Many services support either Anthropic or
          OpenAI-compatible requests.
        </div>
      )}

      <input
        className="aiKeyInput"
        type="text"
        spellCheck={false}
        placeholder='Name (optional—e.g. "DeepSeek", "work key")'
        value={aiKeysForm.name}
        onChange={(event) => setAiKeysForm((form) => ({ ...form, name: event.target.value }))}
      />
      {!oauth ? (
        <>
          <input
            className="aiKeyInput"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={
              aiKeysForm.id ? "API key (leave empty to keep the current one)" : "API key"
            }
            value={aiKeysForm.api_key}
            onChange={(event) =>
              setAiKeysForm((form) => ({ ...form, api_key: event.target.value }))
            }
            onBlur={() => {
              if (aiKeysForm.api_key?.trim()) loadModelCatalog();
            }}
          />
          <input
            className="aiKeyInput"
            type="text"
            spellCheck={false}
            placeholder={`Base URL (optional—default ${protocol?.default_base_url || ""})`}
            value={aiKeysForm.base_url}
            onChange={(event) =>
              setAiKeysForm((form) => ({ ...form, base_url: event.target.value }))
            }
          />
        </>
      ) : null}

      <div className="reportModalHint aiModelsHead settingsNoMargin">
        <span>
          Models shown in the chat model menu
          {formModels.length === 0
            ? ` (none picked: uses ${protocol?.default_model || "the provider default"})`
            : ""}
        </span>
        <button
          className="searchToggle transferClearBtn"
          disabled={!!aiModelCatalog?.loading || formOauthPending}
          title={
            formOauthPending
              ? "Connect with ChatGPT first"
              : "Fetch models available to this credential"
          }
          onClick={loadModelCatalog}
        >
          {aiModelCatalog?.loading ? (
            <>
              <span className="transferSpin inline" /> fetching models…
            </>
          ) : aiModelCatalog?.models ? (
            `↻ ${aiModelCatalog.models.length} usable models`
          ) : formOauthPending ? (
            "Models list after connect"
          ) : (
            "Fetch usable models"
          )}
        </button>
      </div>
      {formModels.length ? (
        <div className="aiModelChips">
          {formModels.map((model) => (
            <span className="categoryTag" key={model}>
              {model}
              <button
                className="uiClose uiCloseSm"
                title="Remove model"
                aria-label={`Remove ${model}`}
                onClick={() => removeModel(model)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="aiProvPwForm">
        <input
          className="aiKeyInput"
          type="text"
          spellCheck={false}
          list="aiModelSuggestions"
          placeholder={
            aiModelCatalog?.loading
              ? "Add a model—loading the provider's list…"
              : availModels.length
                ? `Add a model—type or pick (${availModels.length} available), Enter to add`
                : "Add a model—Enter to add"
          }
          value={customModel}
          onChange={(event) => {
            const next = event.target.value;
            const inputType = event.nativeEvent?.inputType;
            if (
              (!inputType || inputType === "insertReplacementText") &&
              availModels.includes(next)
            ) {
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
          {availModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </div>
      {aiModelCatalog?.error ? (
        <div className="reportModalHint settingsNoMargin">
          {aiModelCatalog.error}{" "}
          <button
            className="searchToggle"
            title="Retry loading the model list"
            onClick={loadModelCatalog}
          >
            ↻
          </button>
        </div>
      ) : null}
      <div className="reportModalBtns">
        <button
          className="uiBtn"
          onClick={() => {
            setAiKeysForm(null);
            setAiKeysError("");
          }}
        >
          Cancel
        </button>
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
      {aiKeysError ? <div className="settingsPaneHint aiKeysError">{aiKeysError}</div> : null}
    </div>
  );
}

function AiSettings({ value }) {
  const activeKeyId = value.aiKeysInfo?.providers.some((item) => item.id === value.aiProvider)
    ? value.aiProvider
    : value.aiKeysInfo?.providers[0]?.id;
  return (
    <>
      <PaneIntro title="AI & API keys">
        Bring your own API keys. They are stored on the server and never returned to the browser.
        The selected credential is used for AI requests; its configured models appear in the chat
        model menu. The menu is also refreshed automatically (about once a day) with the latest
        models each account lists — hit ↻ in the chat header to fetch right now.
      </PaneIntro>
      {!value.aiKeysInfo && !value.aiKeysError ? (
        <div className="settingsPaneHint">Loading…</div>
      ) : null}
      {value.aiKeysInfo ? (
        <>
          {value.aiKeysInfo.providers.length === 0 && !value.aiKeysForm ? (
            <div className="settingsPaneHint">
              {value.aiKeysInfo.can_edit
                ? "No keys yet—add one to enable AI chat, metadata extraction, and citations."
                : "Guest accounts can't store API keys. Ask the admin for an account to use AI features."}
            </div>
          ) : null}
          {value.aiKeysInfo.providers.map((provider) => {
            const protocol = value.aiProtocolOf(provider.protocol);
            const test = value.aiKeyTests?.[provider.id];
            return (
              <label
                key={provider.id}
                className={`aiProvRow aiProvSelectable ${activeKeyId === provider.id ? "active" : ""}`}
              >
                {value.aiKeysInfo.providers.length > 1 ? (
                  <input
                    type="radio"
                    className="aiProvRadio"
                    name="activeAiKey"
                    checked={activeKeyId === provider.id}
                    onChange={() => value.setAiProvider(provider.id)}
                    title="Use this key for AI requests"
                  />
                ) : null}
                <span className="aiProvMeta">
                  <span className="aiProvName">
                    {provider.name || protocol?.label || provider.protocol}
                    {activeKeyId === provider.id ? (
                      <span className="aiProvActiveBadge">in use</span>
                    ) : null}
                  </span>
                  <span className="aiProvDesc">
                    {value.isOauthProto(provider.protocol)
                      ? `${provider.oauth_connected ? `signed in${provider.account ? ` as ${provider.account}` : ""}` : "not connected"} · ChatGPT subscription`
                      : `key ${provider.key_hint || "set"} · ${protocol?.label || provider.protocol}`}
                    {provider.base_url ? ` · ${provider.base_url}` : ""}
                    {provider.created_at
                      ? ` · added ${new Date(provider.created_at).toLocaleDateString()}`
                      : ""}
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
                        ? "Testing… sending a tiny request"
                        : test.ok
                          ? `✓ working · ${test.model} · ${(test.latency_ms / 1000).toFixed(1)}s`
                          : `✗ ${test.error}`}
                    </span>
                  ) : null}
                </span>
                {value.aiKeysInfo.can_edit ? (
                  <span className="aiProvActions">
                    <button
                      className="uiBtn sm"
                      disabled={value.aiKeysBusy || test?.busy}
                      title="Send a tiny AI request through this credential to check it still works"
                      onClick={() => value.testAiProvider(provider)}
                    >
                      Test
                    </button>
                    <button
                      className="uiBtn sm iconSq"
                      disabled={value.aiKeysBusy}
                      title="Edit this key"
                      onClick={() => value.startEditAiProvider(provider)}
                    >
                      <PenIcon size={13} />
                    </button>
                    <button
                      className="uiBtn sm iconSq danger"
                      disabled={value.aiKeysBusy}
                      title="Remove this key"
                      onClick={() => value.deleteAiProvider(provider)}
                    >
                      <Trash2Icon size={13} />
                    </button>
                  </span>
                ) : null}
              </label>
            );
          })}
          {value.aiKeysForm ? (
            <ProviderForm value={value} />
          ) : value.aiKeysInfo.can_edit ? (
            <div className="reportModalBtns">
              <button className="uiBtn primary" onClick={value.startAddAiProvider}>
                + Add key
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {!value.aiKeysForm && value.aiKeysError ? (
        <div className="settingsPaneHint aiKeysError">{value.aiKeysError}</div>
      ) : null}
    </>
  );
}

function PromptSettings({ value }) {
  return (
    <>
      <PaneIntro title="Prompts">
        Instructions Gamma sends with each kind of AI request. Custom prompts are saved in this
        browser.
      </PaneIntro>
      {[
        [
          "Chat system prompt",
          value.chatSystem,
          value.promptDraft,
          value.setPromptDraft,
          value.aiInfo?.default_prompt,
          5,
        ],
        [
          "Metadata extraction",
          value.metaPrompt,
          value.metaPromptDraft,
          value.setMetaPromptDraft,
          value.aiInfo?.metadata_prompt,
          4,
        ],
        [
          "PPT citation",
          value.citePrompt,
          value.citePromptDraft,
          value.setCitePromptDraft,
          value.aiInfo?.cite_prompt,
          4,
        ],
      ].map(([label, custom, draft, setDraft, defaultValue, rows]) => (
        <React.Fragment key={label}>
          <div className="promptSectionHead">
            <span>
              {label}
              {custom ? " · custom" : ""}
            </span>
            <button className="uiBtn sm" onClick={() => setDraft(defaultValue || "")}>
              Reset
            </button>
          </div>
          <textarea
            className="promptTextarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={rows}
          />
        </React.Fragment>
      ))}
      <div className="reportModalBtns">
        <button className="uiBtn primary" onClick={value.savePrompts}>
          Save prompts
        </button>
      </div>
    </>
  );
}

function ContextSettings({ value }) {
  const limits = [
    [
      "Single-paper chat",
      "Maximum characters extracted from the open paper for a normal chat message.",
      value.chatContextChars,
      value.setChatContextChars,
    ],
    [
      "Metadata extraction",
      "Maximum characters read while detecting identifiers and extracting paper metadata.",
      value.metaContextChars,
      value.setMetaContextChars,
    ],
    [
      "Multi-paper chat total",
      "Total character budget shared evenly by the selected papers.",
      value.multiContextChars,
      value.setMultiContextChars,
    ],
  ];
  return (
    <>
      <PaneIntro title="AI chat">
        Chat behavior and how much extracted PDF text Gamma sends to the AI. Larger context values
        can improve answers but use more tokens.
      </PaneIntro>
      <SettingToggle
        label="Clear snapshots when clicking elsewhere"
        description="A plain click in the PDF clears the quoted text selections under the chat. Turn this on to also drop pending rectangle snapshots with that click — images pasted into the chat are never touched."
        checked={value.chatImgAutoClear}
        onChange={value.setChatImgAutoClear}
      />
      <label className="settingRow">
        <span className="settingText">
          <span className="settingLabel">Voice dictation model</span>
          <span className="settingDesc">
            Speech-to-text for the chat's mic button. gpt-4o-transcribe is what ChatGPT's dictation
            uses; needs an OpenAI-protocol provider key.
          </span>
        </span>
        <select
          className="aiKeyInput settingSelect"
          value={value.dictationModel}
          onChange={(e) => value.setDictationModel(e.target.value)}
        >
          <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
          <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
          <option value="whisper-1">whisper-1</option>
        </select>
      </label>
      <label className="settingRow">
        <span className="settingText">
          <span className="settingLabel">Voice dictation language</span>
          <span className="settingDesc">
            Telling the model the spoken language improves accuracy; auto-detect handles mixed or
            unlisted languages.
          </span>
        </span>
        <select
          className="aiKeyInput settingSelect"
          value={value.dictationLang}
          onChange={(e) => value.setDictationLang(e.target.value)}
        >
          <option value="">Auto-detect</option>
          <option value="en">English</option>
          <option value="zh">中文 (Chinese)</option>
          <option value="ja">日本語 (Japanese)</option>
          <option value="ko">한국어 (Korean)</option>
          <option value="de">Deutsch (German)</option>
          <option value="fr">Français (French)</option>
          <option value="es">Español (Spanish)</option>
          <option value="pt">Português (Portuguese)</option>
          <option value="it">Italiano (Italian)</option>
          <option value="ru">Русский (Russian)</option>
          <option value="hi">हिन्दी (Hindi)</option>
          <option value="ar">العربية (Arabic)</option>
        </select>
      </label>
      {limits.map(([label, description, current, setCurrent]) => (
        <label className="settingRow" key={label}>
          <span className="settingText">
            <span className="settingLabel">{label}</span>
            <span className="settingDesc">{description}</span>
          </span>
          <input
            className="aiKeyInput contextLimitInput"
            type="number"
            min="100"
            max="1000000"
            step="1000"
            value={current}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) setCurrent(Math.min(1000000, Math.max(100, next)));
            }}
          />
        </label>
      ))}
      <div className="reportModalBtns">
        <button className="uiBtn" onClick={value.reset}>
          Reset defaults
        </button>
      </div>
    </>
  );
}

function SearchSettings({ value }) {
  const rebuild = () => requestReindex(value.setStatus, "in the background.");
  return (
    <>
      <PaneIntro title="Search">
        Full-text search covers your notes and every PDF in the library. PDFs are indexed
        automatically in the background.
      </PaneIntro>
      <SettingToggle
        label="Expand result details on the home page"
        description="Search from the library opens with full result lists. With no PDF open, the compact find bar has nothing to show."
        checked={value.searchDetailsHome}
        onChange={value.setSearchDetailsHome}
      />
      <SettingToggle
        label="Expand result details in a paper"
        description="Open search with full result lists while reading a paper. When off, search starts as a compact find bar."
        checked={value.searchDetailsPaper}
        onChange={value.setSearchDetailsPaper}
      />
      <div className="settingRow">
        <span className="settingText">
          <span className="settingLabel">Rebuild the PDF text index</span>
          <span className="settingDesc">
            Re-extract every paper when library-wide results look stale or incomplete.
          </span>
        </span>
        <button className="uiBtn sm" disabled={value.indexTask?.active} onClick={rebuild}>
          {value.indexTask?.active ? "Indexing…" : "Rebuild"}
        </button>
      </div>
    </>
  );
}

// Newest-first log list with a Copy button — one rendering for the session
// log and the admin server log. Entries are normalized to {key, timeMs, text}.
function LogBox({ label, description, entries, emptyText, copyStatus, setStatus }) {
  function copy() {
    const text = entries
      .map(
        (entry) =>
          `${new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })} ${entry.text}`,
      )
      .join("\n");
    copyText(text).then(
      (ok) => setStatus(ok ? copyStatus : "Copy failed—copy manually."),
    );
  }
  return (
    <>
      <div className="settingRow">
        <span className="settingText">
          <span className="settingLabel">{label}</span>
          <span className="settingDesc">{description}</span>
        </span>
        <button className="uiBtn sm" disabled={!entries.length} onClick={copy}>
          Copy
        </button>
      </div>
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

// Admin-only view of the backend's in-memory log (GET /api/admin/logs).
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
      label="Server log"
      description="Backend events since the server started, newest first. Secrets are masked; visible to admins only."
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

function DiagnosticsSettings({ value }) {
  return (
    <>
      <PaneIntro title="Diagnostics">
        Status messages appear briefly as a floating pill. Pin them to a permanent bar or inspect
        this session's log.
      </PaneIntro>
      <SettingToggle
        label="Show status bar"
        description="Keep the latest status message visible below the tabs."
        checked={value.statusBarVisible}
        onChange={value.setStatusBarVisible}
      />
      <SettingToggle
        label="Debug logging"
        description="Trace reading-position tracking, restore, and sync events into the system log below (and the browser console)."
        checked={value.debugLog}
        onChange={value.setDebugLog}
      />
      <LogBox
        label="System log"
        description="Application events from this session, newest first."
        entries={value.sysLog.map((entry, index) => ({
          key: index,
          timeMs: entry.t,
          text: entry.msg,
        }))}
        emptyText="Nothing logged yet this session."
        copyStatus="Log copied."
        setStatus={value.setStatus}
      />
      {value.isAdmin ? <ServerLogBox setStatus={value.setStatus} /> : null}
    </>
  );
}

// Settings → Users: the GUI for /api/admin/users*, plus the backup/restore
// actions for each account (the Data button — they used to live in the account
// popover). One combined editor per account — name, password, privilege,
// storage limits, delete — instead of scattered per-action forms.
//
// Non-admins get this pane too, as "Account": a single read-only row for
// themselves with the Data button. /api/admin/* is admin-only, so their row is
// built from the session + /api/quota instead of the accounts listing, and
// there is no editor — the same rule the backend enforces on /api/export and
// /api/import-data (your own account, unless you are an admin).
function UsersSettings({ value }) {
  const { setStatus, confirm, onSelfRenamed, refreshQuota, closeSettings, openDataFor,
          isAdmin, me, isGuest, quotaInfo, exportUserData, importUserData } = value;
  const [info, setInfo] = React.useState(null); // {users, me}
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [edit, setEdit] = React.useState(null); // {original, username, password, is_admin, max_upload_mb, quota_mb}
  const [addForm, setAddForm] = React.useState(null); // {username, password, is_admin}
  // Username whose backup panel is open. The popover's "Backup & restore…"
  // opens this pane already pointed at your own row, so an admin doesn't have
  // to find themselves in a list of accounts first.
  const [dataFor, setDataFor] = React.useState(openDataFor || null);

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

  function openData(u) {
    setError("");
    setEdit(null);
    setAddForm(null);
    setDataFor(u.username);
  }

  // Export/import report progress in the status pill and the background-tasks
  // popover, and the import confirm box wants the screen — so get out of the
  // settings modal first.
  function runDataAction(fn) {
    closeSettings?.();
    fn();
  }

  function openEdit(u) {
    setError("");
    setAddForm(null);
    setDataFor(null);
    setEdit({
      original: u,
      username: u.username,
      password: "",
      is_admin: !!u.is_admin,
      max_upload_mb: u.max_upload_mb ?? "",
      quota_mb: u.quota_mb ?? "",
    });
  }

  // "" = inherit the server default (sent as explicit null), digits = override
  function parseLimit(s) {
    const t = String(s ?? "").trim();
    if (!t) return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : NaN;
  }

  async function saveEdit() {
    const u = edit.original;
    const maxMb = parseLimit(edit.max_upload_mb);
    const quotaMb = parseLimit(edit.quota_mb);
    if (Number.isNaN(maxMb) || Number.isNaN(quotaMb)) {
      setError("Storage limits must be whole numbers of MB, or blank for the server default.");
      return;
    }
    const payload = {};
    if (edit.password) payload.password = edit.password;
    if (!u.is_guest && edit.is_admin !== !!u.is_admin) payload.is_admin = edit.is_admin;
    if (maxMb !== (u.max_upload_mb ?? null)) payload.max_upload_mb = maxMb;
    if (quotaMb !== (u.quota_mb ?? null)) payload.quota_mb = quotaMb;
    const newName = u.is_guest ? u.username : (edit.username || "").trim();
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
    if (u.username === myName) refreshQuota?.();
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

  // Backup/restore for one account. Admins get it on every row; everyone else
  // only ever sees their own (the pane shows no other accounts).
  function dataForm(u) {
    const mine = u.username === myName;
    const who = mine ? "your" : `${u.username}'s`;
    return (
      <div className="aiProvForm" key={u.username}>
        <div className="promptSectionHead"><span>{mine ? "Your data" : `${u.username}'s data`}</span></div>
        <QuotaMeter usedBytes={u.used_bytes} quotaMb={u.quota_mb ?? defaults?.quota_mb} />
        <span className="settingDesc formFieldLabel">
          A backup zip holds {who} notes databases (pages, highlights, chats, settings) and,
          unless you pick the small one, every uploaded PDF and image.
        </span>
        <div className="reportModalBtns settingsAlignStart settingsDataBtns">
          <button
            className="uiBtn"
            title={`Download a zip backup: ${who} notes databases + every uploaded PDF`}
            onClick={() => runDataAction(() => exportUserData(true, u.username))}
          >
            <ExportIcon size={13} /> Export data (.zip)
          </button>
          <button
            className="uiBtn"
            title="Download a small zip with just the databases (notes, chats, settings) — no uploaded PDFs"
            onClick={() => runDataAction(() => exportUserData(false, u.username))}
          >
            <ExportIcon size={13} /> Export database only (.zip)
          </button>
        </div>
        {u.is_guest ? (
          <span className="settingDesc">
            The guest workspace is shared and resets daily — backups can't be restored into it.
          </span>
        ) : (
          <div className="reportModalBtns settingsAlignStart settingsDataBtns">
            <button
              className="uiBtn"
              title={`Restore an exported zip: ${who} notes and settings are replaced by the backup, uploaded files are merged in`}
              onClick={() => runDataAction(() => importUserData("replace", u.username))}
            >
              <ImportIcon size={13} /> Import data (.zip)…
            </button>
            <button
              className="uiBtn"
              title={`Add pages from an exported zip that are missing there; everything already in ${mine ? "your" : "that"} account is kept unchanged`}
              onClick={() => runDataAction(() => importUserData("merge", u.username))}
            >
              <ImportIcon size={13} /> Import &amp; merge (.zip)…
            </button>
          </div>
        )}
        <div className="reportModalBtns">
          <button className="uiBtn" onClick={() => setDataFor(null)}>Close</button>
        </div>
      </div>
    );
  }

  function editForm(u) {
    // effective quota = this account's override, else the server default
    const effQuota = u.quota_mb ?? defaults?.quota_mb;
    const defUpload = defaults ? `server default (${defaults.max_upload_mb} MB)` : "server default";
    const defQuota = defaults
      ? `server default (${defaults.quota_mb ? `${defaults.quota_mb} MB` : "unlimited"})`
      : "server default";
    return (
      <div className="aiProvForm" key={u.username}>
        <div className="promptSectionHead">
          <span>{u.is_guest ? "Guest storage limits" : `Edit ${u.username}`}</span>
        </div>
        <QuotaMeter usedBytes={u.used_bytes} quotaMb={effQuota} />
        {!u.is_guest ? (
          <>
            <span className="settingDesc formFieldLabel">
              Username — change it to rename the account (sessions and share links keep working)
            </span>
            <input
              className="aiKeyInput"
              type="text"
              spellCheck={false}
              value={edit.username}
              onChange={(e) => setEdit((f) => ({ ...f, username: e.target.value }))}
            />
            <input
              className="aiKeyInput"
              type="password"
              autoComplete="new-password"
              placeholder="New password — blank keeps the current one"
              value={edit.password}
              onChange={(e) => setEdit((f) => ({ ...f, password: e.target.value }))}
            />
            <label
              className="uiCheckRow"
              title={lastAdmin(u) ? "The last admin can't be demoted" : ""}
            >
              <input
                type="checkbox"
                checked={edit.is_admin}
                disabled={lastAdmin(u)}
                onChange={(e) => setEdit((f) => ({ ...f, is_admin: e.target.checked }))}
              />
              Admin privilege
            </label>
          </>
        ) : null}
        <span className="settingDesc formFieldLabel">
          Max upload size (MB) — largest single PDF/image; blank = server default
        </span>
        <input
          className="aiKeyInput"
          type="number"
          min={1}
          placeholder={defUpload}
          value={edit.max_upload_mb}
          onChange={(e) => setEdit((f) => ({ ...f, max_upload_mb: e.target.value }))}
        />
        <span className="settingDesc formFieldLabel">
          Storage quota (MB) — total for all uploads; blank = server default, 0 = unlimited
        </span>
        <input
          className="aiKeyInput"
          type="number"
          min={0}
          placeholder={defQuota}
          value={edit.quota_mb}
          onChange={(e) => setEdit((f) => ({ ...f, quota_mb: e.target.value }))}
        />
        <div className="reportModalBtns">
          {!u.is_guest && u.username !== myName ? (
            <button className="uiBtn danger" disabled={busy} onClick={() => deleteAccount(u)}>
              <Trash2Icon size={13} /> Delete…
            </button>
          ) : null}
          <button
            className="uiBtn"
            onClick={() => {
              setEdit(null);
              setError("");
            }}
          >
            Cancel
          </button>
          <button className="uiBtn primary" disabled={busy} onClick={saveEdit}>
            Save
          </button>
        </div>
      </div>
    );
  }

  function userRow(u) {
    return (
      <div key={u.username} className="aiProvRow">
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
                ? `created ${new Date(u.created_at).toLocaleDateString()}`
                : "signed in"}
            {u.max_upload_mb != null ? ` · max file ${u.max_upload_mb} MB` : ""}
            {u.quota_mb != null
              ? u.quota_mb
                ? ` · quota ${u.quota_mb} MB`
                : " · quota unlimited"
              : ""}
          </span>
          <QuotaMeter usedBytes={u.used_bytes} quotaMb={u.quota_mb ?? defaults?.quota_mb} />
        </span>
        <span className="aiProvActions">
          <button
            className="uiBtn sm iconSq"
            title={u.username === myName ? "Back up or restore your data" : `Back up or restore ${u.username}'s data`}
            aria-label="Backup and restore"
            onClick={() => openData(u)}
          >
            <DatabaseIcon size={13} />
          </button>
          {isAdmin ? (
            <button
              className="uiBtn sm iconSq" disabled={busy}
              title={u.is_guest ? "Guest storage limits" : `Edit ${u.username}`}
              aria-label="Edit account"
              onClick={() => openEdit(u)}
            >
              <PenIcon size={13} />
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  const rowFor = (u) => (
    dataFor === u.username ? dataForm(u)
      : edit?.original.username === u.username ? editForm(u)
        : userRow(u)
  );

  return (
    <>
      {isAdmin ? (
        <PaneIntro title="Users">
          Accounts on this server. Admin is a privilege, not a name — any account can be granted it,
          and the last admin can never be demoted or deleted. Storage limits left blank inherit the
          server defaults from the Paper metadata pane. The database button backs up or restores an
          account's whole workspace.
        </PaneIntro>
      ) : (
        <PaneIntro title="Account">
          Your account and its storage. The database button downloads a backup of everything you
          have here, or restores one. Only an admin can rename accounts, change passwords or set
          storage limits.
        </PaneIntro>
      )}
      {isAdmin && !info && !error ? <div className="reportModalHint">Loading…</div> : null}
      {rows.map(rowFor)}
      {!isAdmin ? null : addForm ? (
        <div className="aiProvForm">
          <div className="promptSectionHead">
            <span>Add user</span>
          </div>
          <input
            className="aiKeyInput"
            type="text"
            spellCheck={false}
            autoFocus
            placeholder="Username (letters, digits, _ . -)"
            value={addForm.username}
            onChange={(e) => setAddForm((f) => ({ ...f, username: e.target.value }))}
          />
          <input
            className="aiKeyInput"
            type="password"
            autoComplete="new-password"
            placeholder="Password"
            value={addForm.password}
            onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitAdd();
            }}
          />
          <label className="uiCheckRow">
            <input
              type="checkbox"
              checked={!!addForm.is_admin}
              onChange={(e) => setAddForm((f) => ({ ...f, is_admin: e.target.checked }))}
            />
            Grant the admin privilege
          </label>
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
      {error ? <div className="reportModalHint aiKeysError">{error}</div> : null}
    </>
  );
}

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
  // The users pane doubles as every non-admin's own "Account" pane — same
  // component, but it only ever shows their row (see UsersSettings).
  const navItems = NAV_ITEMS.map(([id, label, Icon]) =>
    (id === "users" && !users?.isAdmin ? [id, "Account", UserIcon] : [id, label, Icon]))
    .filter(([id]) => id !== "users" || users);
  return (
    <div className="reportOverlay" onClick={onClose}>
      <div className="settingsModal" onClick={(event) => event.stopPropagation()}>
        <div className="settingsSidebar">
          <div className="settingsSideTitle">Settings</div>
          {navItems.map(([id, label, Icon]) => (
            <button
              key={id}
              className={`settingsNavBtn ${activePane === id ? "active" : ""}`}
              onClick={() => onPaneChange(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
        <div className="settingsPane">
          <button
            className="uiClose uiCloseLg settingsClose"
            onClick={onClose}
            title="Close settings"
            aria-label="Close settings"
          >
            ×
          </button>
          {activePane === "papers" ? <PapersSettings value={papers} /> : null}
          {activePane === "notes" ? <NotesSettings value={notes} /> : null}
          {activePane === "library" ? <LibrarySettings value={library} /> : null}
          {activePane === "ai" ? <AiSettings value={ai} /> : null}
          {activePane === "prompts" ? <PromptSettings value={prompts} /> : null}
          {activePane === "context" ? <ContextSettings value={context} /> : null}
          {activePane === "search" ? <SearchSettings value={search} /> : null}
          {activePane === "users" && users ? <UsersSettings value={users} /> : null}
          {activePane === "diagnostics" ? <DiagnosticsSettings value={diagnostics} /> : null}
        </div>
      </div>
    </div>
  );
}
