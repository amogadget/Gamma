import React from "react";
import { API, apiJson } from "./utils";
import { parseFolderTags } from "./libraryUtils";
import {
  ActivityIcon,
  BookIcon,
  KeyIcon,
  ListIcon,
  PaperIcon,
  PenIcon,
  SearchIcon,
  SlidersIcon,
  Trash2Icon,
} from "./icons";

const NAV_ITEMS = [
  ["papers", "Paper metadata", PaperIcon],
  ["library", "Library status", ListIcon],
  ["ai", "AI & API keys", KeyIcon],
  ["prompts", "Prompts", SlidersIcon],
  ["context", "AI chat", BookIcon],
  ["search", "Search", SearchIcon],
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

function SettingToggle({ label, description, checked, onChange }) {
  return (
    <label className="settingRow">
      <span className="settingText">
        <span className="settingLabel">{label}</span>
        <span className="settingDesc">{description}</span>
      </span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="switchTrack" />
      </span>
    </label>
  );
}

function PapersSettings({ value }) {
  return (
    <>
      <PaneIntro title="Paper metadata">
        How papers are fetched, stored, and enriched when you open them. These preferences are saved in this browser.
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
      <SettingToggle
        label="Note badges on highlights"
        description="Show a small speech-bubble next to a highlight in the PDF when you've typed a note on it. Click the bubble to jump to the note."
        checked={value.hlNoteBadges}
        onChange={value.setHlNoteBadges}
      />
      <label className="settingRow">
        <span className="settingText">
          <span className="settingLabel">Embedded PDF annotations</span>
          <span className="settingDesc">
            Highlights, notes, and rectangle annotations saved inside a PDF file (a Gamma export,
            SumatraPDF, Acrobat…) are imported as regular highlights — this controls what happens to
            the embedded originals so they don't render twice. "Hide in viewer" leaves the file untouched; "Strip from file" removes them
            from the stored PDF when they're imported.
          </span>
        </span>
        <select className="aiKeyInput settingSelect" value={value.embAnnots}
          onChange={(e) => value.setEmbAnnots(e.target.value)}>
          <option value="hide">Hide in viewer</option>
          <option value="strip">Strip from file</option>
        </select>
      </label>
      <MetaModelRow value={value} />
    </>
  );
}

function LibrarySettings({ value }) {
  return (
    <>
      <PaneIntro title="Library status">
        Per-paper health of your library: metadata, extracted PDF text, and the search index —
        with batch retry for failed or missing metadata lookups.
      </PaneIntro>
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
  const current = value.metaModel && models.some((m) => m.id === value.metaModel) ? value.metaModel : "";
  return (
    <label className="settingRow">
      <span className="settingText">
        <span className="settingLabel">Metadata model</span>
        <span className="settingDesc">Model used when metadata has to be AI-extracted from the PDF text (no arXiv id or DOI found). A fast, cheap model works well for this.</span>
      </span>
      <select className="aiKeyInput settingSelect" value={current}
        onChange={(e) => value.setMetaModel(e.target.value)}>
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
    setStatus(result.busy
      ? "Indexing is already running—see the tasks popover."
      : result.scheduled
        ? `Re-indexing ${result.scheduled} paper${result.scheduled === 1 ? "" : "s"} ${scheduledSuffix}`
        : "No papers with PDFs to index.");
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
      setSelected((prev) => new Set([...prev].filter((id) => (data.papers || []).some((p) => p.id === id))));
    } catch (err) {
      setError(err.message);
      setPapers((prev) => prev || []);
    }
  }
  React.useEffect(() => { refresh(); }, []);

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

  const reindex = () => requestReindex(value.setStatus, "— text status fills in as it runs.");

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const allSelected = list.length > 0 && selected.size === list.length;

  const metaCell = (p) => (
    p.has_meta
      ? <span className="metaStatOk">✓ {p.meta_source === "ai" ? "AI" : p.meta_source || "yes"}</span>
      : p.meta_error
        ? <span className="metaStatBad" title={p.meta_error}>✗ failed</span>
        : <span className="metaStatMuted">—</span>
  );
  // Text and index are separate columns: extraction state is only known once
  // the indexer has visited the doc, so an unindexed paper shows "?" here.
  const textCell = (p) => (
    p.text_chars === null
      ? <span className="metaStatMuted" title="Unknown until the paper is indexed — Reindex to find out">?</span>
      : textOk(p)
        ? <span className="metaStatOk" title={`${p.text_chars.toLocaleString()} characters extracted`}>✓ {p.text_chars >= 1000 ? `${Math.round(p.text_chars / 1000)}k` : p.text_chars}</span>
        : <span className="metaStatBad" title={p.has_file ? "No text layer — scanned or image-only?" : "PDF file not on the server"}>✗ no text</span>
  );
  const indexCell = (p) => (
    p.indexed
      ? <span className="metaStatOk">✓ indexed</span>
      : p.index_stale
        ? <span className="metaStatMuted" title="Indexed with an older extractor version — Reindex refreshes it">stale</span>
        : <span className="metaStatMuted" title="Not in the search index yet">—</span>
  );

  return (
    <>
      <div className="promptSectionHead metaStatHead">
        <span>Papers</span>
        <span className="metaStatActions">
          <select className="homeSortSelect" value={sortMode} onChange={(e) => setSortMode(e.target.value)} title="Sort papers">
            <option value="meta">Metadata — unfinished first</option>
            <option value="text">PDF text — unfinished first</option>
            <option value="updated">Recently modified</option>
          </select>
          <button className="uiBtn sm" onClick={reindex} title="Re-extract every paper's text into the search index (also fills in the text column)">Reindex</button>
          <button className="uiBtn sm" onClick={refresh} disabled={!!busy}>Refresh</button>
        </span>
      </div>
      {papers === null ? <div className="reportModalHint">Loading…</div> : null}
      {error ? <div className="reportModalHint">Status failed: {error}</div> : null}
      {papers !== null && !list.length ? <div className="reportModalHint">No papers yet — open a PDF first.</div> : null}
      {list.length ? (
        <>
          <div className="metaStatSummary">
            Out of {list.length} paper{list.length === 1 ? "" : "s"}: <b>{counts.meta}</b> with metadata
            · <b>{counts.text}</b> with extracted text · <b>{counts.indexed}</b> indexed for search
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
              <span>PDF text</span>
              <span>Index</span>
            </div>
            {sorted.map((p) => (
              <label key={p.id} className="metaStatRow">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="metaStatTitle" title={p.title}>{p.title}</span>
                {metaCell(p)}
                {textCell(p)}
                {indexCell(p)}
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
              <button className="uiBtn sm" disabled={!selected.size}
                onClick={() => retry(list.filter((p) => selected.has(p.id)))}>
                Retry selected{selected.size ? ` (${selected.size})` : ""}
              </button>
              <button className="uiBtn sm" disabled={!missing.length}
                onClick={() => retry(missing)}>
                Retry missing ({missing.length})
              </button>
              <button className="uiBtn sm" onClick={() => retry(list)}>Retry all ({list.length})</button>
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
      <div className="promptSectionHead"><span>{aiKeysForm.id ? "Edit key" : "Add key"}</span></div>
      <select
        className="aiKeyInput"
        value={aiKeysForm.protocol}
        onChange={(event) => setAiKeysForm((form) => ({ ...form, protocol: event.target.value }))}
      >
        {aiKeysInfo.protocols.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>

      {oauth ? (
        <>
          <div className="reportModalHint">
            No API key—usage is billed to your ChatGPT Plus/Pro subscription.
            <ol className="oauthInstructions">
              <li>Open ChatGPT sign-in below and log in.</li>
              <li>The login ends on a localhost error page; that is expected.</li>
              <li>Copy the full callback URL from the browser address bar.</li>
              <li>Paste it below and select Connect.</li>
            </ol>
          </div>
          <div className="reportModalBtns settingsAlignStart">
            <button className="uiBtn" disabled={aiKeysBusy} onClick={startChatGPTAuth}>
              {aiKeysForm.oauthState ? "Re-open ChatGPT sign-in" : "Open ChatGPT sign-in"}
            </button>
          </div>
          <input
            className="aiKeyInput"
            type="text"
            spellCheck={false}
            placeholder="Paste the callback URL"
            value={aiKeysForm.oauthCallback || ""}
            onChange={(event) => setAiKeysForm((form) => ({ ...form, oauthCallback: event.target.value }))}
          />
        </>
      ) : (
        <div className="reportModalHint">
          Pick the API format, not the vendor. Many services support either Anthropic or OpenAI-compatible requests.
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
            placeholder={aiKeysForm.id ? "API key (leave empty to keep the current one)" : "API key"}
            value={aiKeysForm.api_key}
            onChange={(event) => setAiKeysForm((form) => ({ ...form, api_key: event.target.value }))}
            onBlur={() => { if (aiKeysForm.api_key?.trim()) loadModelCatalog(); }}
          />
          <input
            className="aiKeyInput"
            type="text"
            spellCheck={false}
            placeholder={`Base URL (optional—default ${protocol?.default_base_url || ""})`}
            value={aiKeysForm.base_url}
            onChange={(event) => setAiKeysForm((form) => ({ ...form, base_url: event.target.value }))}
          />
        </>
      ) : null}

      <div className="reportModalHint aiModelsHead settingsNoMargin">
        <span>
          Models shown in the chat model menu
          {formModels.length === 0 ? ` (none picked: uses ${protocol?.default_model || "the provider default"})` : ""}
        </span>
        <button
          className="searchToggle transferClearBtn"
          disabled={!!aiModelCatalog?.loading || formOauthPending}
          title={formOauthPending ? "Connect with ChatGPT first" : "Fetch models available to this credential"}
          onClick={loadModelCatalog}
        >
          {aiModelCatalog?.loading
            ? <><span className="transferSpin inline" /> fetching models…</>
            : aiModelCatalog?.models
              ? `↻ ${aiModelCatalog.models.length} usable models`
              : formOauthPending ? "Models list after connect" : "Fetch usable models"}
        </button>
      </div>
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
          className="aiKeyInput"
          type="text"
          spellCheck={false}
          list="aiModelSuggestions"
          placeholder={aiModelCatalog?.loading
            ? "Add a model—loading the provider's list…"
            : availModels.length
              ? `Add a model—type or pick (${availModels.length} available), Enter to add`
              : "Add a model—Enter to add"}
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
      </div>
      {aiModelCatalog?.error ? (
        <div className="reportModalHint settingsNoMargin">
          {aiModelCatalog.error}{" "}
          <button className="searchToggle" title="Retry loading the model list" onClick={loadModelCatalog}>↻</button>
        </div>
      ) : null}
      <div className="reportModalBtns">
        <button className="uiBtn" onClick={() => { setAiKeysForm(null); setAiKeysError(""); }}>Cancel</button>
        <button className="uiBtn primary" disabled={aiKeysBusy} onClick={submitAiProvider}>
          {aiKeysBusy
            ? "Saving…"
            : oauth
              ? ((aiKeysForm.oauthCallback || "").trim() || !aiKeysForm.id ? "Connect" : "Save changes")
              : aiKeysForm.id ? "Save changes" : "Add key"}
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
        Bring your own API keys. They are stored on the server and never returned to the browser. The selected
        credential is used for AI requests; its configured models appear in the chat model menu.
      </PaneIntro>
      {!value.aiKeysInfo && !value.aiKeysError ? <div className="settingsPaneHint">Loading…</div> : null}
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
            return (
              <label key={provider.id} className={`aiProvRow aiProvSelectable ${activeKeyId === provider.id ? "active" : ""}`}>
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
                    {activeKeyId === provider.id ? <span className="aiProvActiveBadge">in use</span> : null}
                  </span>
                  <span className="aiProvDesc">
                    {value.isOauthProto(provider.protocol)
                      ? `${provider.oauth_connected ? `signed in${provider.account ? ` as ${provider.account}` : ""}` : "not connected"} · ChatGPT subscription`
                      : `key ${provider.key_hint || "set"} · ${protocol?.label || provider.protocol}`}
                    {provider.base_url ? ` · ${provider.base_url}` : ""}
                    {provider.created_at ? ` · added ${new Date(provider.created_at).toLocaleDateString()}` : ""}
                  </span>
                  <span className="aiProvDesc aiProvModels">
                    {(parseFolderTags(provider.models).length
                      ? parseFolderTags(provider.models)
                      : [protocol?.default_model || "provider default"]).map((model) => (
                      <span className="categoryTag" key={model}>{model}</span>
                    ))}
                  </span>
                </span>
                {value.aiKeysInfo.can_edit ? (
                  <span className="aiProvActions">
                    <button className="uiBtn sm iconSq" disabled={value.aiKeysBusy} title="Edit this key" onClick={() => value.startEditAiProvider(provider)}>
                      <PenIcon size={13} />
                    </button>
                    <button className="uiBtn sm iconSq danger" disabled={value.aiKeysBusy} title="Remove this key" onClick={() => value.deleteAiProvider(provider)}>
                      <Trash2Icon size={13} />
                    </button>
                  </span>
                ) : null}
              </label>
            );
          })}
          {value.aiKeysForm
            ? <ProviderForm value={value} />
            : value.aiKeysInfo.can_edit
              ? <div className="reportModalBtns"><button className="uiBtn primary" onClick={value.startAddAiProvider}>+ Add key</button></div>
              : null}
        </>
      ) : null}
      {!value.aiKeysForm && value.aiKeysError ? <div className="settingsPaneHint aiKeysError">{value.aiKeysError}</div> : null}
    </>
  );
}

function PromptSettings({ value }) {
  return (
    <>
      <PaneIntro title="Prompts">
        Instructions Gamma sends with each kind of AI request. Custom prompts are saved in this browser.
      </PaneIntro>
      {[
        ["Chat system prompt", value.chatSystem, value.promptDraft, value.setPromptDraft, value.aiInfo?.default_prompt, 5],
        ["Metadata extraction", value.metaPrompt, value.metaPromptDraft, value.setMetaPromptDraft, value.aiInfo?.metadata_prompt, 4],
        ["PPT citation", value.citePrompt, value.citePromptDraft, value.setCitePromptDraft, value.aiInfo?.cite_prompt, 4],
      ].map(([label, custom, draft, setDraft, defaultValue, rows]) => (
        <React.Fragment key={label}>
          <div className="promptSectionHead">
            <span>{label}{custom ? " · custom" : ""}</span>
            <button className="uiBtn sm" onClick={() => setDraft(defaultValue || "")}>Reset</button>
          </div>
          <textarea className="promptTextarea" value={draft} onChange={(event) => setDraft(event.target.value)} rows={rows} />
        </React.Fragment>
      ))}
      <div className="reportModalBtns">
        <button className="uiBtn primary" onClick={value.savePrompts}>Save prompts</button>
      </div>
    </>
  );
}

function ContextSettings({ value }) {
  const limits = [
    ["Single-paper chat", "Maximum characters extracted from the open paper for a normal chat message.", value.chatContextChars, value.setChatContextChars],
    ["Metadata extraction", "Maximum characters read while detecting identifiers and extracting paper metadata.", value.metaContextChars, value.setMetaContextChars],
    ["Multi-paper chat total", "Total character budget shared evenly by the selected papers.", value.multiContextChars, value.setMultiContextChars],
  ];
  return (
    <>
      <PaneIntro title="AI chat">
        Chat behavior and how much extracted PDF text Gamma sends to the AI. Larger context values can improve answers but use more tokens.
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
          <span className="settingDesc">Speech-to-text for the chat's mic button. gpt-4o-transcribe is what ChatGPT's dictation uses; needs an OpenAI-protocol provider key.</span>
        </span>
        <select className="aiKeyInput settingSelect" value={value.dictationModel}
          onChange={(e) => value.setDictationModel(e.target.value)}>
          <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
          <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
          <option value="whisper-1">whisper-1</option>
        </select>
      </label>
      <label className="settingRow">
        <span className="settingText">
          <span className="settingLabel">Voice dictation language</span>
          <span className="settingDesc">Telling the model the spoken language improves accuracy; auto-detect handles mixed or unlisted languages.</span>
        </span>
        <select className="aiKeyInput settingSelect" value={value.dictationLang}
          onChange={(e) => value.setDictationLang(e.target.value)}>
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
      <div className="reportModalBtns"><button className="uiBtn" onClick={value.reset}>Reset defaults</button></div>
    </>
  );
}

function SearchSettings({ value }) {
  const rebuild = () => requestReindex(value.setStatus, "in the background.");
  return (
    <>
      <PaneIntro title="Search">
        Full-text search covers your notes and every PDF in the library. PDFs are indexed automatically in the background.
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
          <span className="settingDesc">Re-extract every paper when library-wide results look stale or incomplete.</span>
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
      .map((entry) => `${new Date(entry.timeMs).toLocaleTimeString([], { hour12: false })} ${entry.text}`)
      .join("\n");
    navigator.clipboard?.writeText(text).then(
      () => setStatus(copyStatus),
      () => setStatus("Copy failed—copy manually."),
    );
  }
  return (
    <>
      <div className="settingRow">
        <span className="settingText">
          <span className="settingLabel">{label}</span>
          <span className="settingDesc">{description}</span>
        </span>
        <button className="uiBtn sm" disabled={!entries.length} onClick={copy}>Copy</button>
      </div>
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
      label="Server log"
      description="Backend events since the server started, newest first. Secrets are masked; visible to admins only."
      entries={shown}
      emptyText={error ? `Server log unavailable: ${error}`
        : entries ? "Nothing logged since the server started."
          : "Loading…"}
      copyStatus="Server log copied."
      setStatus={setStatus}
    />
  );
}

function DiagnosticsSettings({ value }) {
  return (
    <>
      <PaneIntro title="Diagnostics">
        Status messages appear briefly as a floating pill. Pin them to a permanent bar or inspect this session's log.
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
        entries={value.sysLog.map((entry, index) => ({ key: index, timeMs: entry.t, text: entry.msg }))}
        emptyText="Nothing logged yet this session."
        copyStatus="Log copied."
        setStatus={value.setStatus}
      />
      {value.isAdmin ? <ServerLogBox setStatus={value.setStatus} /> : null}
    </>
  );
}

export default function SettingsDialog({
  activePane,
  onPaneChange,
  onClose,
  papers,
  library,
  ai,
  prompts,
  context,
  search,
  diagnostics,
}) {
  if (!activePane) return null;
  return (
    <div className="reportOverlay" onClick={onClose}>
      <div className="settingsModal" onClick={(event) => event.stopPropagation()}>
        <div className="settingsSidebar">
          <div className="settingsSideTitle">Settings</div>
          {NAV_ITEMS.map(([id, label, Icon]) => (
            <button key={id} className={`settingsNavBtn ${activePane === id ? "active" : ""}`} onClick={() => onPaneChange(id)}>
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
        <div className="settingsPane">
          <button className="uiClose uiCloseLg settingsClose" onClick={onClose} title="Close settings" aria-label="Close settings">×</button>
          {activePane === "papers" ? <PapersSettings value={papers} /> : null}
          {activePane === "library" ? <LibrarySettings value={library} /> : null}
          {activePane === "ai" ? <AiSettings value={ai} /> : null}
          {activePane === "prompts" ? <PromptSettings value={prompts} /> : null}
          {activePane === "context" ? <ContextSettings value={context} /> : null}
          {activePane === "search" ? <SearchSettings value={search} /> : null}
          {activePane === "diagnostics" ? <DiagnosticsSettings value={diagnostics} /> : null}
        </div>
      </div>
    </div>
  );
}
