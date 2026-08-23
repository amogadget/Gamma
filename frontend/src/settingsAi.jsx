// Settings → Providers: the user's AI credential list (OpenAI-platform style)
// and the add/edit-key wizard. All state and handlers live in App.jsx (the
// aiKeys* group) — these components only render it.
import React from "react";
import { parseFolderTags } from "./libraryUtils";
import { MenuSelect } from "./menus";
import { PaneHead, Section, SubDialog, Step, Field, Empty } from "./settingsKit";
import { KeyIcon, PenIcon, RefreshIcon, SparklesIcon, Trash2Icon } from "./icons";

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
                      : [protocol?.default_model || "provider default"]).map((model) => (
                      <span className="categoryTag" key={model}>{model}</span>
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
      {!value.aiKeysForm && value.aiKeysError ? <div className="settingsPaneHint aiKeysError">{value.aiKeysError}</div> : null}
    </>
  );
}
