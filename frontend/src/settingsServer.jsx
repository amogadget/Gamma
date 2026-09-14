// Settings → Server (admins only): everything that is about the server
// rather than one account — the storage defaults every account inherits,
// every workspace on the server (settingsWorkspacesAdmin.jsx), whole-data-
// directory snapshots (settingsBackups.jsx ServerBackups) and the scrubbed
// server log. Per-account things stay in Users; per-workspace backups in
// Backups.
import React from "react";
import { API, apiJson } from "./utils";
import { PaneHead, Section, Row, UnitInput, LogBox } from "./settingsKit";
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
        "Server-wide cap on a single uploaded PDF or image. Override it per account from the Users pane.", 1, "Upload limit")}
      {row("quota_mb", ServerIcon, "Default quota", "Total uploads per account · 0 = unlimited",
        "Server-wide total of an account's personal workspaces; 0 means unlimited. Override it per account from the Users pane; shared workspaces carry their own quota.", 0, "Storage quota")}
    </>
  );
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
