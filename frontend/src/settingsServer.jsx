// Settings → Server (admins only): everything that is about the server
// rather than one account — the storage defaults every account inherits,
// every workspace on the server (settingsWorkspacesAdmin.jsx), whole-data-
// directory snapshots (settingsBackups.jsx ServerBackups) and the scrubbed
// server log. Per-account things stay in Users; per-workspace backups in
// Backups.
import React from "react";
import { API, apiJson } from "./utils";
import { PaneHead, Section, Row, UnitInput, LogBox, useSettingsDraft } from "./settingsKit";
import { WorkspacesAdmin } from "./settingsWorkspacesAdmin";
import { ServerBackups } from "./settingsBackups";
import { ImportIcon, ServerIcon } from "./icons";

export function ServerSettings({ value }) {
  return (
    <>
      <PaneHead icon={ServerIcon} title="Server">
        Storage defaults, every workspace on the server, snapshots of the whole data directory, and the server log.
      </PaneHead>
      <Section title="Storage defaults">
        <ServerLimitRows setStatus={value.setStatus} refreshQuota={value.refreshQuota} />
      </Section>
      <WorkspacesAdmin value={value} />
      <ServerBackups setStatus={value.setStatus} confirm={value.confirm} />
      <Section title="Log">
        <ServerLogBox setStatus={value.setStatus} />
      </Section>
    </>
  );
}

// Server-wide default storage limits (users.db via /api/admin/settings).
// Per-account overrides live in the Users pane.
function ServerLimitRows({ setStatus, refreshQuota }) {
  const [saved, setSaved] = React.useState(null);
  const [draft, setDraft] = React.useState({ max_upload_mb: "", quota_mb: "" });
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const asDraft = (value) => ({ max_upload_mb: String(value.max_upload_mb), quota_mb: String(value.quota_mb) });
  React.useEffect(() => {
    apiJson(`${API}/admin/settings`).then((value) => { setSaved(value); setDraft(asDraft(value)); })
      .catch((err) => setError(err.message));
  }, []);
  const dirty = !!saved && Object.keys(draft).some((key) => draft[key] !== String(saved[key]));
  const valid = /^\d+$/.test(draft.max_upload_mb) && Number(draft.max_upload_mb) >= 1
    && /^\d+$/.test(draft.quota_mb);
  const discard = () => { if (saved) setDraft(asDraft(saved)); setError(""); };
  useSettingsDraft("server-limits", dirty, discard);
  async function save() {
    if (!dirty || !valid || busy) return;
    setBusy(true); setError("");
    try {
      const value = await apiJson(`${API}/admin/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_upload_mb: Number(draft.max_upload_mb), quota_mb: Number(draft.quota_mb) }),
      });
      setSaved(value); setDraft(asDraft(value)); refreshQuota?.();
      setStatus("Storage defaults saved.");
    } catch (err) { setError(`Could not save: ${err.message}`); }
    finally { setBusy(false); }
  }
  return <>
    {saved ? <>
      <Row icon={ImportIcon} label="Default max upload" hint="Largest single PDF or image per account. Users can have individual overrides.">
        <UnitInput unit="MB" min={1} value={draft.max_upload_mb}
          onChange={(next) => setDraft((previous) => ({ ...previous, max_upload_mb: next }))} onEnter={save} />
      </Row>
      <Row icon={ServerIcon} label="Default quota" hint="Total personal-workspace uploads per account. 0 means unlimited; shared workspaces have their own quota.">
        <UnitInput unit="MB" min={0} value={draft.quota_mb}
          onChange={(next) => setDraft((previous) => ({ ...previous, quota_mb: next }))} onEnter={save} />
      </Row>
      <div className="reportModalBtns">
        <button className="uiBtn sm" disabled={!dirty || busy} onClick={discard}>Cancel</button>
        <button className="uiBtn sm primary" disabled={!dirty || !valid || busy} onClick={save}>{busy ? "Saving..." : "Save limits"}</button>
      </div>
    </> : !error ? <p className="setNotice">Loading storage defaults...</p> : null}
    {error ? <p className="settingsPaneHint aiKeysError" role="alert">{error}</p> : null}
  </>;
}

// The backend's in-memory log (GET /api/admin/logs). Polls with a seq
// cursor while the pane is open; secrets are scrubbed server-side before
// entries ever reach the buffer.
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
      description="Backend events since startup · secrets masked"
      entries={shown}
      emptyText={error ? `Server log unavailable: ${error}`
        : entries ? "Nothing logged since the server started."
          : "Loading…"}
      copyStatus="Server log copied."
      setStatus={setStatus}
    />
  );
}
