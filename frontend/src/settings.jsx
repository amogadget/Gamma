import React from "react";
import { API, apiJson } from "./utils";
import { parseFolderTags } from "./libraryUtils";
import {
  ActivityIcon,
  BookIcon,
  KeyIcon,
  PaperIcon,
  PenIcon,
  SearchIcon,
  SlidersIcon,
  Trash2Icon,
} from "./icons";

const NAV_ITEMS = [
  ["papers", "Papers & PDFs", PaperIcon],
  ["ai", "AI & API keys", KeyIcon],
  ["prompts", "Prompts", SlidersIcon],
  ["context", "AI context", BookIcon],
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
      <PaneIntro title="Papers & PDFs">
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
      <PaneIntro title="AI context">
        Control how much extracted PDF text Gamma sends to the AI. Larger values can improve answers but use more tokens.
      </PaneIntro>
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
  async function rebuild() {
    try {
      const result = await apiJson(`${API}/search-reindex`, { method: "POST" });
      value.setStatus(result.busy
        ? "Indexing is already running—see the tasks popover."
        : result.scheduled
          ? `Re-indexing ${result.scheduled} paper${result.scheduled === 1 ? "" : "s"} in the background.`
          : "No papers with PDFs to index.");
    } catch (error) {
      value.setStatus(`Reindex failed: ${error.message}`);
    }
  }
  return (
    <>
      <PaneIntro title="Search">
        Full-text search covers your notes and every PDF in the library. PDFs are indexed automatically in the background.
      </PaneIntro>
      <SettingToggle
        label="Expand result details by default"
        description="Open search with full result lists visible. When off, search starts as a compact find bar."
        checked={value.searchDetailsDefault}
        onChange={value.setSearchDetailsDefault}
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

function DiagnosticsSettings({ value }) {
  function copyLog() {
    const text = value.sysLog
      .map((entry) => `${new Date(entry.t).toLocaleTimeString([], { hour12: false })} ${entry.msg}`)
      .join("\n");
    navigator.clipboard?.writeText(text).then(
      () => value.setStatus("Log copied."),
      () => value.setStatus("Copy failed—copy manually."),
    );
  }
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
      <div className="settingRow">
        <span className="settingText">
          <span className="settingLabel">System log</span>
          <span className="settingDesc">Application events from this session, newest first.</span>
        </span>
        <button className="uiBtn sm" disabled={!value.sysLog.length} onClick={copyLog}>Copy</button>
      </div>
      <div className="sysLogBox">
        {value.sysLog.length ? [...value.sysLog].reverse().map((entry, index) => (
          <div key={value.sysLog.length - index} className="sysLogRow">
            <span className="sysLogTime">{new Date(entry.t).toLocaleTimeString([], { hour12: false })}</span>
            <span className="sysLogMsg">{entry.msg}</span>
          </div>
        )) : <div className="sysLogEmpty">Nothing logged yet this session.</div>}
      </div>
    </>
  );
}

export default function SettingsDialog({
  activePane,
  onPaneChange,
  onClose,
  papers,
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
