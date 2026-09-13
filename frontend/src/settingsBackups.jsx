// Settings → Advanced → Server backups (admins): snapshots of the whole data
// directory under backups/ — take one now (databases only, or with every
// uploaded file), download as a zip, delete. GUI for /api/admin/backups*
// (gamma/backups.py). Restoring one is a stopped-server operation:
// `manage.py backups --restore <name>` (docs/dev/migrations.md).
import React from "react";
import { API, apiJson, fmtBytes } from "./utils";
import { ActionMenu } from "./menus";
import { Section, Empty } from "./settingsKit";
import { DatabaseIcon, DownloadIcon, HardDriveIcon, PlusIcon, Trash2Icon } from "./icons";

export function ServerBackups({ setStatus, confirm }) {
  const [rows, setRows] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(() => {
    apiJson(`${API}/admin/backups`).then((d) => setRows([...d.backups].reverse())).catch((e) => setError(e.message));
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  async function create(uploads) {
    setBusy(true);
    setError("");
    setStatus(uploads ? "Backing up databases and uploads…" : "Backing up databases…");
    try {
      const b = await apiJson(`${API}/admin/backups`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: uploads ? "full" : "db", uploads }),
      });
      setStatus(`Backup ${b.name} created (${fmtBytes(b.size_bytes)}).`);
      refresh();
    } catch (e) {
      setError(e.message);
      setStatus(`Backup failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function download(b) {
    // A plain navigation: the response is an attachment, so the page stays.
    const a = document.createElement("a");
    a.href = `${API}/admin/backups/${encodeURIComponent(b.name)}/download`;
    a.download = `gamma-backup-${b.name}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function remove(b) {
    confirm({
      title: "Delete backup",
      message: `Delete the snapshot ${b.name} (${fmtBytes(b.size_bytes)})? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await apiJson(`${API}/admin/backups/${encodeURIComponent(b.name)}`, { method: "DELETE" });
          setStatus(`Deleted ${b.name}.`);
          refresh();
        } catch (e) { setError(e.message); }
      },
    });
  }

  const when = (b) => (b.created_at ? new Date(b.created_at).toLocaleString() : b.name);

  return (
    <Section
      title="Server backups"
      action={(
        <ActionMenu
          label="Back up now" icon={PlusIcon} disabled={busy}
          items={[
            { icon: DatabaseIcon, label: "Databases only", title: "Every account's and workspace's database — small and quick; uploaded PDFs are not copied",
              onClick: () => create(false) },
            { icon: HardDriveIcon, label: "Everything", title: "Databases plus every uploaded PDF and image — a complete copy of the data directory",
              onClick: () => create(true) },
          ]}
        />
      )}
    >
      {rows === null && !error ? <Empty icon={DatabaseIcon}>Loading…</Empty> : null}
      {rows && !rows.length ? <Empty icon={DatabaseIcon}>No snapshots yet. The server also takes one before every data upgrade.</Empty> : null}
      {(rows || []).map((b) => (
        <div key={b.name} className="aiProvRow">
          <span className={`aiProvAvatar ${b.uploads ? "active" : ""}`}>
            {b.uploads ? <HardDriveIcon size={15} /> : <DatabaseIcon size={15} />}
          </span>
          <span className="aiProvMeta">
            <span className="aiProvName">
              {when(b)}
              <span className="uiTag">{b.label || "backup"}</span>
            </span>
            <span className="aiProvDesc">
              {fmtBytes(b.size_bytes)} · {(b.files || []).length} database file{(b.files || []).length === 1 ? "" : "s"}
              {b.uploads ? ` + ${b.upload_files || 0} uploads` : " · databases only"}
              {b.schema_version != null ? ` · schema v${b.schema_version}` : ""}
            </span>
          </span>
          <span className="aiProvActions">
            <button className="uiBtn sm iconSq" title="Download as a zip" aria-label="Download" onClick={() => download(b)}>
              <DownloadIcon size={13} />
            </button>
            <button className="uiBtn sm iconSq" title="Delete this snapshot" aria-label="Delete" disabled={busy} onClick={() => remove(b)}>
              <Trash2Icon size={13} />
            </button>
          </span>
        </div>
      ))}
      <div className="settingsPaneHint">
        Snapshots live in <code>backups/</code> inside the data directory. To roll back, stop the server and run
        <code> manage.py backups --restore &lt;name&gt;</code>.
      </div>
      {error ? <div className="settingsPaneHint aiKeysError">{error}</div> : null}
    </Section>
  );
}
