// Settings → Providers: the user's AI credential list (OpenAI-platform style)
// and the add/edit-key wizard. All state and handlers live in App.jsx (the
// aiKeys* group) — these components only render it.
import React from "react";
import { parseFolderTags } from "./libraryUtils";
import { MenuSelect } from "./menus";
import { PaneHead, Section, SubDialog, Step, Field, Empty, PercentMeter, Row } from "./settingsKit";
import { GlobeIcon, KeyIcon, MicIcon, PaperIcon, PenIcon, RefreshIcon, SparklesIcon, Trash2Icon } from "./icons";

const DICTATION_LANGS = [
  ["", "Auto-detect"], ["en", "English"], ["zh", "中文"], ["ja", "日本語"], ["ko", "한국어"],
  ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["pt", "Português"],
  ["it", "Italiano"], ["ru", "Русский"], ["hi", "हिन्दी"], ["ar", "العربية"],
];

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Subscription allowance for a ChatGPT sign-in provider. The endpoint is
// best-effort (the provider API is undocumented), so every failure renders as
// an explanation rather than breaking the pane.
function ProviderUsage({ usage }) {
  if (usage.busy) return <span className="aiProvDesc">Checking usage…</span>;
  if (!usage.available) {
    return <span className="aiProvDesc aiKeysError">{usage.reason || "Usage percentage unavailable"}</span>;
  }
  return (
    <span className="aiUsage">
      {(usage.windows || []).map((window, index) => {
        const used = Number(window.used_percent) || 0;
        const left = Number(window.remaining_percent) || 0;
        const reset = window.reset_at
          ? `resets ${new Date(window.reset_at * 1000).toLocaleString([], {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}`
          : "";
        const label = [usage.plan_type ? `${usage.plan_type}` : "", window.name]
          .filter(Boolean).join(" · ");
        const detail = `${formatPercent(used)}% used · ${formatPercent(left)}% left${reset ? ` · ${reset}` : ""}`;
        return (
          <span className="aiUsageWindow" key={`${window.name}-${index}`}>
            <span className="aiUsageHead">
              <span>{label}</span>
              <span title={detail}>{detail}</span>
            </span>
            <PercentMeter percent={used} barOnly />
          </span>
        );
      })}
    </span>
  );
}

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
        <Field label="Test model" hint="used by the Test button and the login connection check">
          <MenuSelect
            label="Test model"
            value={formModels.includes(aiKeysForm.test_model) ? aiKeysForm.test_model : ""}
            onChange={(model) => setAiKeysForm((form) => ({ ...form, test_model: model }))}
            options={[
              ["", "Auto — metadata model, else first"],
              ...formModels.map((model) => [model, model]),
            ]}
          />
        </Field>
      </Step>

      {aiKeysError ? <div className="settingsPaneHint aiKeysError">{aiKeysError}</div> : null}
      <div className="reportModalBtns">
        <button className="uiBtn" onClick={onCancel}>Cancel</button>
        <button className="uiBtn primary" disabled={aiKeysBusy} onClick={submitAiProvider}>
          {aiKeysBusy
            ? "Saving…"
            : oauth
              ? ((aiKeysForm.oauthCallback || "").trim() || !aiKeysForm.id ? "Connect" : "Save changes")
              : aiKeysForm.id ? "Save changes" : "Add key"}
        </button>
      </div>
    </div>
  );
}

export function AiSettings({ value }) {
  const closeKeyForm = () => { value.setAiKeysForm(null); value.setAiKeysError(""); };
  const activeKeyId = value.aiKeysInfo?.providers.some((item) => item.id === value.aiProvider)
    ? value.aiProvider
    : value.aiKeysInfo?.providers[0]?.id;
  const canEdit = value.aiKeysInfo?.can_edit;
  const providers = value.aiKeysInfo?.providers || [];
  return (
    <>
      <PaneHead icon={KeyIcon} title="Provider and models">
        Connect AI providers and configure every model available to chat and AI jobs.
        Keys are stored on the server and never sent back to the browser.
      </PaneHead>
      <Section title="AI jobs">
        <Row icon={PaperIcon} label="Metadata model"
          hint="Used only when identifiers cannot resolve the paper"
          title="Metadata first tries arXiv and DOI records. This model is used only when metadata has to be AI-extracted from PDF text; a fast, cheap model is usually enough.">
          <MenuSelect
            label="Metadata model"
            value={value.metaModel && (value.aiModels || []).some((model) => model.id === value.metaModel)
              ? value.metaModel : ""}
            onChange={value.setMetaModel}
            options={[
              ["", "Same as chat"],
              ...(value.aiModels || []).map((model) => [model.id, model.model]),
            ]}
          />
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
          {providers.length ? <Section title={providers.length > 1 ? "Providers · pick the one AI requests use" : "Provider"} /> : null}
          {providers.map((provider) => {
            const protocol = value.aiProtocolOf(provider.protocol);
            const test = value.aiKeyTests?.[provider.id];
            const usage = value.aiKeyUsage?.[provider.id];
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
                    <span className="aiProvModelsLabel">Models</span>
                    {(parseFolderTags(provider.models).length
                      ? parseFolderTags(provider.models)
                      : [protocol?.default_model || "provider default"]).map((model) => (
                      <span className="categoryTag" key={model}>{model}</span>
                    ))}
                  </span>
                  {test ? (
                    <span
                      className={`aiProvDesc ${test.busy ? "" : test.ok ? "aiTestOk" : "aiKeysError"}`}
                      title={!test.busy && !test.ok ? test.error : undefined}
                    >
                      {test.busy
                        ? "Testing…"
                        : test.ok
                          ? `✓ working · ${test.model} · ${(test.latency_ms / 1000).toFixed(1)}s`
                          : test.auth ? (
                            // Broken credential: one clear line + the fix,
                            // never the upstream body (hover shows the detail).
                            <>
                              ✗ {oauth ? "ChatGPT sign-in expired" : "API key rejected"} —{" "}
                              <button
                                className="chatEmptyLink"
                                onClick={(event) => { event.preventDefault(); value.startEditAiProvider(provider); }}
                              >
                                {oauth ? "reconnect" : "update the key"}
                              </button>
                            </>
                          ) : `✗ ${test.error}`}
                    </span>
                  ) : null}
                  {usage ? (
                    <ProviderUsage usage={usage} />
                  ) : null}
                </span>
                {canEdit ? (
                  <span className="aiProvActions">
                    <button className="uiBtn sm" disabled={value.aiKeysBusy || test?.busy}
                      title="Send a tiny AI request through this credential to check it still works"
                      onClick={() => value.testAiProvider(provider)}>
                      Test
                    </button>
                    <button className="uiBtn sm" disabled={value.aiKeysBusy || usage?.busy}
                      title="Query remaining allowance; subscription percentages are available for ChatGPT sign-in providers"
                      onClick={() => value.queryAiProviderUsage(provider)}>
                      Usage
                    </button>
                    <button className="uiBtn sm" disabled={value.aiKeysBusy}
                      title="Configure all models offered by this provider"
                      onClick={() => value.startEditAiProvider(provider)}>
                      Models
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
              <button className="uiBtn primary" onClick={value.startAddAiProvider}>+ Add provider</button>
            </div>
          ) : null}
          {canEdit ? (
            <Section title="Connection">
              <Row icon={RefreshIcon} label="Check at login"
                hint="Verify the active provider when Gamma opens"
                title="Runs a connection check on the active provider at login; a failure (expired ChatGPT sign-in, rejected key, unreachable provider) shows a warning in the chat window instead of surfacing as a broken chat later. The credential check is free — OAuth entries query subscription usage, API keys list models; the test request sends a tiny completion (through the provider's test model — by default your metadata model) and spends a few tokens.">
                <MenuSelect
                  label="Check at login"
                  value={value.aiLoginCheck}
                  onChange={value.setAiLoginCheck}
                  options={[
                    ["ping", "Credential check (free)"],
                    ["test", "Test request (uses tokens)"],
                    ["off", "Off"],
                  ]}
                />
              </Row>
            </Section>
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
      {!value.aiKeysForm && value.aiKeysError ? <div className="settingsPaneHint aiKeysError">{value.aiKeysError}</div> : null}
    </>
  );
}
