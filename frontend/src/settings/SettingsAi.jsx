// Settings → Providers: the user's AI credential list (OpenAI-platform style)
// and the add/edit-key wizard. All state and handlers live in App.jsx (the
// aiKeys* group) — these components only render it.
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { parseFolderTags } from "../library/libraryUtils";
import { MenuSelect } from "../shared/ui/Menus";
import { cachedPercent, fmtTokens, usageDetail } from "../chat/tokenUsage";
import { ModelPicker } from "./ModelPicker";
import { Section, SubDialog, Step, Field, Empty, PercentMeter, Row, PasswordInput, StatText } from "./SettingsKit";
import { ActivityIcon, GlobeIcon, KeyIcon, MicIcon, PaperIcon, RefreshIcon, SparklesIcon, Trash2Icon } from "../shared/ui/Icons";

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
  const [service, setService] = React.useState(() => {
    const protocol = aiProtocolOf(aiKeysForm.protocol);
    return aiKeysForm.base_url && aiKeysForm.base_url.replace(/\/$/, "") !== protocol?.default_base_url?.replace(/\/$/, "")
      ? "custom" : aiKeysForm.protocol;
  });
  const oauth = isOauthProto(aiKeysForm.protocol);
  const protocol = aiProtocolOf(aiKeysForm.protocol);

  return (
    <div className="settingsForm">
      <Step n={1} title="Connect a service" hint="Choose a service, or use your own endpoint.">
        <MenuSelect block label="AI service" value={service}
          onChange={(next) => {
            setService(next);
            if (next !== "custom") setAiKeysForm((form) => ({ ...form, protocol: next, base_url: "", models: "", test_model: "" }));
            else if (oauth) setAiKeysForm((form) => ({ ...form, protocol: "openai", base_url: "", models: "", test_model: "" }));
          }} options={[
            ...aiKeysInfo.protocols.map((item) => [item.id, ({ openai: "OpenAI API", anthropic: "Anthropic", chatgpt: "ChatGPT subscription" })[item.id] || item.label]),
            ["custom", "Custom endpoint"],
          ]} />
        {service === "custom" ? <Field label="API format" hint="Use the format supported by your service">
          <MenuSelect block label="API protocol" value={aiKeysForm.protocol}
            onChange={(protocol) => setAiKeysForm((form) => ({ ...form, protocol }))}
            options={aiKeysInfo.protocols.filter((item) => !isOauthProto(item.id)).map((item) => [item.id, item.label])} />
        </Field> : null}
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
              <PasswordInput
                autoComplete="new-password" spellCheck={false}
                placeholder="sk-…"
                value={aiKeysForm.api_key}
                onChange={(event) => setAiKeysForm((form) => ({ ...form, api_key: event.target.value }))}
              />
            </Field>
            {service === "custom" ? <Field label="Base URL" hint={`optional — default ${protocol?.default_base_url || ""}`}>
              <input
                className="aiKeyInput" type="text" spellCheck={false}
                placeholder={protocol?.default_base_url || ""}
                value={aiKeysForm.base_url}
                onChange={(event) => setAiKeysForm((form) => ({ ...form, base_url: event.target.value }))}
              />
            </Field> : null}
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
          <ModelPicker models={availModels} value={customModel}
            onChange={setCustomModel} onAdd={addCatalogModel} loading={aiModelCatalog?.loading} />
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

const USAGE_KIND_LABELS = { chat: "Chat", translate: "Translation", metadata: "Metadata", cite: "Citations", test: "Connection tests" };

// Settings → AI → Token usage: what the account's AI calls cost in tokens,
// as the providers reported it (GET /api/ai/usage — one row per call in
// users.db, see gamma/ai_usage.py). Three tiles for today / 7 days /
// 30 days, the all-time line with Reset, then the last 30 days by model
// and by kind. No prices: they differ per provider and change.
function AiUsageSection({ confirm, setStatus }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      setData(await apiJson(`${API}/ai/usage`));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  function reset() {
    const run = async () => {
      try {
        await apiJson(`${API}/ai/usage`, { method: "DELETE" });
        setStatus?.("Token usage reset");
        load();
      } catch (err) {
        setStatus?.(`Couldn't reset token usage: ${err.message}`);
      }
    };
    if (confirm) {
      confirm({ title: "Reset token usage", message: "Forget every recorded token count of this account? The providers' own dashboards are not affected.", confirmLabel: "Reset", danger: true, onConfirm: run });
    } else run();
  }

  const w = data?.windows || {};
  const tile = (label, u, icon = ActivityIcon) => (
    <StatText icon={icon} label={label}
      value={u?.calls ? `↑ ${fmtTokens(u.input)} · ↓ ${fmtTokens(u.output)}` : "—"}
      hint={u?.calls ? `${u.calls} call${u.calls === 1 ? "" : "s"}${cachedPercent(u) ? ` · ${cachedPercent(u)}% cached` : ""}` : "no calls"}
      title={u?.calls ? usageDetail(u) : "No AI calls in this window"} />
  );
  const all = w.all;
  const since = data?.first_at ? new Date(data.first_at).toLocaleDateString() : "";
  const models = data?.models || [];
  const kinds = Object.entries(data?.kinds || {}).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
  return (
    <>
      <Section title="Token usage" action={
        <button className="uiBtn sm" disabled={busy} title="Fetch the latest counts" onClick={load}>
          <RefreshIcon size={12} /> Refresh
        </button>} />
      {error ? <p className="settingsPaneHint aiKeysError" role="alert">Usage unavailable: {error}</p> : null}
      {!data && !error ? <p className="setNotice">Loading…</p> : null}
      {data ? <>
        <div className="setStats">
          {tile("today", w.today)}
          {tile("last 7 days", w.week)}
          {tile("last 30 days", w.month)}
        </div>
        <Row icon={ActivityIcon} label="All time"
          hint={all?.calls
            ? `↑ ${fmtTokens(all.input)} in · ↓ ${fmtTokens(all.output)} out · ${all.calls} calls${since ? ` since ${since}` : ""}`
            : "No AI calls recorded yet — counts appear once a provider reports them."}
          title={`Prompt tokens in, reply tokens out, as each provider reported them. Rows older than ${data.keep_days} days are dropped. ${usageDetail(all)}`}>
          <button className="uiBtn sm danger" disabled={!all?.calls} onClick={reset}>Reset</button>
        </Row>
        {models.length ? (
          <div className="aiUsageTable" role="table" aria-label="Token usage by model, last 30 days">
            <div className="aiUsageRow aiUsageHeader" role="row">
              <span>Model · last 30 days</span><span>calls</span><span>in</span><span>out</span><span>cached</span>
            </div>
            {models.map((m) => (
              <div className="aiUsageRow" role="row" key={`${m.provider_id}:${m.model}`} title={usageDetail(m)}>
                <span className="aiUsageModel">{m.model}{m.provider_name ? <em> · {m.provider_name}</em> : null}</span>
                <span>{m.calls}</span>
                <span>{fmtTokens(m.input)}</span>
                <span>{fmtTokens(m.output)}</span>
                <span>{cachedPercent(m) ? `${cachedPercent(m)}%` : "—"}</span>
              </div>
            ))}
            {kinds.length > 1 ? kinds.map(([kind, u]) => (
              <div className="aiUsageRow aiUsageKind" role="row" key={kind} title={usageDetail(u)}>
                <span className="aiUsageModel">{USAGE_KIND_LABELS[kind] || kind}</span>
                <span>{u.calls}</span>
                <span>{fmtTokens(u.input)}</span>
                <span>{fmtTokens(u.output)}</span>
                <span>{cachedPercent(u) ? `${cachedPercent(u)}%` : "—"}</span>
              </div>
            )) : null}
          </div>
        ) : null}
      </> : null}
    </>
  );
}

export function AiSettings({ value, taskModels, confirm, setStatus }) {
  const closeKeyForm = () => { value.setAiKeysForm(null); value.setAiKeysError(""); };
  const activeKeyId = value.aiKeysInfo?.providers.some((item) => item.id === value.aiProvider)
    ? value.aiProvider
    : value.aiKeysInfo?.providers[0]?.id;
  const canEdit = value.aiKeysInfo?.can_edit;
  const providers = value.aiKeysInfo?.providers || [];
  return (
    <>
      <Section title="Connections" />

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
          <p className="setNotice">Choose the connection used by AI requests. Credentials are saved to your account.</p>
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
                      title="Edit connection and available models" onClick={() => value.startEditAiProvider(provider)}>Manage</button>
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
            <Section title="Connection check">
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
            <SubDialog draft={value.aiKeysForm}
              title={value.aiKeysForm.id ? "Edit key" : "Add key"}
              onClose={closeKeyForm}
            >
              <ProviderForm value={value} onCancel={closeKeyForm} />
            </SubDialog>
          ) : null}
        </>
      ) : null}
      <Section title="Models - this browser">
        {(value.aiModels || []).length ? <Row icon={SparklesIcon} label="Default chat model"
          hint="Also used by citations and generated titles. The chat settings shortcut changes this same preference.">
          <MenuSelect label="Default chat model" value={value.chatModel} onChange={value.setChatModel}
            options={(value.aiModels || []).map((model) => [model.id, model.model])} />
        </Row> : <p className="setNotice">Connect a service to choose models.</p>}
      </Section>
      {value.aiKeysInfo?.can_edit ? <AiUsageSection confirm={confirm} setStatus={setStatus} /> : null}

      <Section title="Models for other tasks">
        <Row icon={PaperIcon} label="Metadata model"
          hint="Used only when identifiers cannot resolve the paper"
          title="Metadata first tries arXiv and DOI records. This model is used only when metadata has to be AI-extracted from PDF text; a fast, cheap model is usually enough.">
          <MenuSelect
            label="Metadata model"
            value={value.metaModel && (value.aiModels || []).some((model) => model.id === value.metaModel)
              ? value.metaModel : ""}
            onChange={value.setMetaModel}
            options={[
              ["", `Same as chat: ${(value.aiModels || []).find((m) => m.id === value.chatModel)?.model || "provider default"}`],
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
      {taskModels}
      </Section>
      {!value.aiKeysForm && value.aiKeysError ? <div className="settingsPaneHint aiKeysError">{value.aiKeysError}</div> : null}
    </>
  );
}
