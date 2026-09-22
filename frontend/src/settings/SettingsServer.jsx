// Settings → Server (admins only): everything that is about the server
// rather than one account — the dashboard (build, uptime, warnings, the
// update check), the storage defaults every account inherits, the shared
// workspaces (settingsWorkspacesAdmin.jsx), whole-data-directory snapshots
// (settingsBackups.jsx ServerBackups) and the scrubbed server log with a
// level filter. Per-account things — including each account's personal
// workspaces — stay in Users; per-workspace backups in Backups.
import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { PaneHead, Section, Row, Segmented, StatText, UnitInput, LogBox } from "./SettingsKit";
import { WorkspacesAdmin } from "./SettingsWorkspacesAdmin";
import { ServerBackups } from "./SettingsBackups";
import { PublicUrlSettings } from "./SettingsPublicUrl";
import { CloudSignInSettings } from "./SettingsCloudSignIn";
import { ActivityIcon, AlertCircleIcon, CloudDownloadIcon, ImportIcon, ServerIcon } from "../shared/ui/Icons";

export function ServerSettings({ value }) {
  return (
    <>
      <PaneHead icon={ServerIcon} title="Server" />
      <Section title="Dashboard">
        <ServerDashboard />
      </Section>
      <Section title="Assistant connections">
        <PublicUrlSettings setStatus={value.setStatus} />
      </Section>
      <Section title="Sign-in">
        <CloudSignInSettings setStatus={value.setStatus} />
      </Section>
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

function fmtUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// What the update row says: newer / current / unknown, in that order of use.
function updateHint(info) {
  const latest = info.latest?.version;
  if (info.update_available) return `v${latest} is out — this server runs v${info.version}`;
  if (info.update_available === false) return `up to date · latest release v${latest}`;
  if (latest) return `latest release v${latest} · this build carries no version to compare`;
  if (info.latest_error) return `could not check: ${info.latest_error}`;
  return "checking…";
}

// GET /api/admin/server-info: the build, uptime, log counts by level and the
// GitHub release check (cached server-side; "Check now" refreshes). A
// Docker server cannot update itself, so an available update is a hint
// to pull the image; the desktop app updates on its own.
function ServerDashboard() {
  const [info, setInfo] = React.useState(null);
  const [error, setError] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const load = React.useCallback(async (refresh) => {
    if (refresh) setChecking(true);
    try {
      setInfo(await apiJson(`${API}/admin/server-info${refresh ? "?refresh=1" : ""}`));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }, []);
  React.useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), 30000);
    return () => clearInterval(timer);
  }, [load]);
  if (!info) {
    return error ? <p className="settingsPaneHint aiKeysError" role="alert">Dashboard unavailable: {error}</p>
      : <p className="setNotice">Loading…</p>;
  }
  const counts = info.log_counts || {};
  const logTone = counts.error ? "error" : counts.warning ? "warn" : "";
  const updateTone = info.update_available ? "warn" : "";
  return <>
    <div className="setStats">
      <StatText icon={ServerIcon} label="version" value={info.version ? `v${info.version}` : "dev build"}
        hint={info.commit ? `build ${info.commit}` : info.frozen ? "desktop app" : "run from a checkout"}
        title={`Gamma ${info.label} · Python ${info.python} · ${info.platform} · data schema ${info.schema_version}`} />
      <StatText icon={ActivityIcon} label="uptime" value={fmtUptime(info.uptime_seconds)}
        hint={`since ${new Date(info.started_at).toLocaleString()}`} />
      <StatText icon={AlertCircleIcon} label="warnings · errors" value={`${counts.warning || 0} · ${counts.error || 0}`}
        hint={`${counts.info || 0} info lines since start`} tone={logTone}
        title="Lines logged since the server started, by level. The log below shows the most recent ones." />
    </div>
    <Row icon={CloudDownloadIcon} label="Updates" hint={updateHint(info)}
      title="Compared against the newest GitHub release. Checked at most every six hours; Check now asks again.">
      <span className="setRowControls">
        {info.latest?.url ? (
          <button className="uiBtn sm" onClick={() => window.open(info.latest.url, "_blank", "noopener")}>Release notes</button>
        ) : null}
        <button className={`uiBtn sm ${updateTone ? "primary" : ""}`} disabled={checking} onClick={() => load(true)}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </span>
    </Row>
    {info.update_available ? (
      <div className="settingsPaneHint">
        A server in Docker does not update itself: pull <code>{info.image}:latest</code> (or <code>:{info.latest.version}</code>) and restart the container. The desktop app updates on its own.
      </div>
    ) : null}
  </>;
}

// Server-wide default storage limits (users.db via /api/admin/settings).
// Per-account overrides live in the Users pane.
// Each limit saves when its box commits (Enter / blur), like every other
// setting; an invalid entry snaps back to the stored value.
function ServerLimitRows({ setStatus, refreshQuota }) {
  const [saved, setSaved] = React.useState(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    apiJson(`${API}/admin/settings`).then(setSaved).catch((err) => setError(err.message));
  }, []);
  async function commit(key, raw, min) {
    const n = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n < min) return; // the box shows the stored value again once the commit settles
    if (n === saved[key]) return;
    setError("");
    try {
      // Only this field: two boxes committing back to back must not overwrite each other.
      const value = await apiJson(`${API}/admin/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: n }),
      });
      setSaved(value); refreshQuota?.();
      setStatus("Storage defaults saved.");
    } catch (err) { setError(`Could not save: ${err.message}`); }
  }
  return <>
    {saved ? <>
      <Row icon={ImportIcon} label="Default max upload" hint="Largest single file; Users can override per account">
        <UnitInput unit="MB" min={1} value={String(saved.max_upload_mb)}
          onCommit={(raw) => commit("max_upload_mb", raw, 1)} />
      </Row>
      <Row icon={ServerIcon} label="Default quota" hint="Personal uploads per account; 0 = unlimited">
        <UnitInput unit="MB" min={0} value={String(saved.quota_mb)}
          onCommit={(raw) => commit("quota_mb", raw, 0)} />
      </Row>
    </> : !error ? <p className="setNotice">Loading…</p> : null}
    {error ? <p className="settingsPaneHint aiKeysError" role="alert">{error}</p> : null}
  </>;
}

const LEVEL_FILTERS = [["all", "All"], ["warn", "Warnings"], ["error", "Errors"]];
const toneOf = (level) => (level === "ERROR" || level === "CRITICAL" ? "error" : level === "WARNING" ? "warn" : "");

// The backend's in-memory log (GET /api/admin/logs). Polls with a seq
// cursor while the pane is open; secrets are scrubbed server-side before
// entries ever reach the buffer. The filter narrows to warnings or errors.
function ServerLogBox({ setStatus }) {
  const [entries, setEntries] = React.useState(null); // null = first poll pending
  const [error, setError] = React.useState("");
  const [level, setLevel] = React.useState("all");
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
  const shown = (entries || [])
    .map((entry) => ({ key: entry.seq, timeMs: entry.t * 1000, text: entry.msg, tone: toneOf(entry.level) }))
    .filter((entry) => level === "all" || (level === "warn" ? !!entry.tone : entry.tone === "error"));
  return (
    <LogBox
      icon={ServerIcon}
      label="Server log"
      description="Backend events since startup · secrets masked"
      entries={shown}
      emptyText={error ? `Server log unavailable: ${error}`
        : !entries ? "Loading…"
          : level === "all" ? "Nothing logged since the server started."
            : `No ${level === "warn" ? "warnings" : "errors"} since the server started.`}
      copyStatus="Server log copied."
      setStatus={setStatus}
      extra={<Segmented value={level} onChange={setLevel} options={LEVEL_FILTERS} />}
    />
  );
}
