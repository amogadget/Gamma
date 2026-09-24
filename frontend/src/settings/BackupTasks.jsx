import React from "react";
import { API, apiJson } from "../shared/lib/utils";
import { ActionMenu, MenuSelect } from "../shared/ui/Menus";
import { ClockIcon, DatabaseIcon, HardDriveIcon, MoreIcon, PlusIcon, Trash2Icon } from "../shared/ui/Icons";
import { Empty, Field, Section, Segmented, SubDialog, Toggle, ToggleGroup } from "./SettingsKit";
import { fmtWhen } from "./SettingsBackups";
import "./backupTasks.css";

const endpoint = `${API}/backup-tasks`;
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const date = (value) => fmtWhen(value, "Not yet");
const pad = (n) => String(n).padStart(2, "0");
const days = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const SCOPES = [["all_owned", "All I own"], ["selected", "Selected"]];
const FREQUENCIES = [["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["custom", "Custom schedule (cron)"]];
const UNITS = [["days", "Days"], ["weeks", "Weeks"], ["months", "Months (30 days)"], ["count", "Snapshots per workspace"]];

// The one cron reader: a five-field expression the editor's presets can
// express → {preset, minute, hour, weekdays, monthday}, or null for any
// other expression (shown raw, edited as "custom").
function parseCron(cron) {
  const [minute, hour, day, month, weekday] = cron.split(/\s+/);
  if (!/^\d+$/.test(minute) || month !== "*") return null;
  const base = { minute: Number(minute), hour: 0, weekdays: [1], monthday: 1 };
  if (hour === "*" && day === "*" && weekday === "*") return { ...base, preset: "hourly" };
  if (!/^\d+$/.test(hour)) return null;
  base.hour = Number(hour);
  if (day === "*" && weekday === "*") return { ...base, preset: "daily" };
  if (day === "*" && /^[0-6](,[0-6])*$/.test(weekday)) return { ...base, preset: "weekly", weekdays: weekday.split(",").map(Number) };
  if (/^\d+$/.test(day) && weekday === "*") return { ...base, preset: "monthly", monthday: Number(day) };
  return null;
}

function frequency(cron) {
  const parsed = parseCron(cron);
  if (!parsed) return cron;
  const time = `${pad(parsed.hour)}:${pad(parsed.minute)}`;
  if (parsed.preset === "hourly") return `Hourly at :${pad(parsed.minute)}`;
  if (parsed.preset === "daily") return `Daily · ${time}`;
  if (parsed.preset === "weekly") return `${parsed.weekdays.map((d) => days.find(([n]) => n === d)[1]).join(", ")} · ${time}`;
  return `Day ${parsed.monthday} · ${time}`;
}

function TaskEditor({ initial, workspaces, onClose, onSaved }) {
  const [draft, setDraft] = React.useState(() => initial || ({
    name: "", enabled: true, scope: "all_owned", workspaces: [], cron: "0 3 * * *", uploads: true,
    retention_mode: "days", retention_value: 30,
  }));
  const [parsed] = React.useState(() => parseCron(initial?.cron || "0 3 * * *"));
  const [preset, setPreset] = React.useState(parsed?.preset || "custom");
  const [time, setTime] = React.useState(parsed ? `${pad(parsed.hour)}:${pad(parsed.minute)}` : "03:00");
  const [weekdays, setWeekdays] = React.useState(parsed?.weekdays || [1]);
  const [monthday, setMonthday] = React.useState(parsed?.monthday || 1);
  const [unit, setUnit] = React.useState(draft.retention_mode === "count" ? "count" : "days");
  const [amount, setAmount] = React.useState(draft.retention_value);
  const [preview, setPreview] = React.useState(null);
  const [previewError, setPreviewError] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const owned = workspaces.filter((w) => w.role === "owner");
  const patch = (values) => setDraft((prev) => ({ ...prev, ...values }));
  const [hour, minute] = time.split(":").map(Number);
  const cron = preset === "custom" ? draft.cron : preset === "hourly" ? `${minute} * * * *`
    : preset === "daily" ? `${minute} ${hour} * * *` : preset === "weekly" ? `${minute} ${hour} * * ${weekdays.join(",")}`
      : `${minute} ${hour} ${monthday} * *`;
  const retention = Number(amount) * ({ days: 1, weeks: 7, months: 30, count: 1 }[unit]);
  React.useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError("");
    const timer = setTimeout(() => {
      apiJson(`${endpoint}/preview`, json("POST", { cron })).then((data) => {
        if (active) setPreview(data.runs);
      }).catch((e) => { if (active) setPreviewError(e.message); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [cron]);

  function choosePreset(value) {
    if (value === "custom") patch({ cron });
    setPreset(value);
  }

  async function submit(event) {
    event.preventDefault();
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(initial?.id ? `${endpoint}/${initial.id}` : endpoint, json(initial?.id ? "PUT" : "POST", {
        ...draft, cron, retention_mode: unit === "count" ? "count" : "days", retention_value: retention,
      }));
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return <SubDialog title={initial?.id ? "Edit backup task" : "Add backup task"} onClose={onClose}
    draft={{ draft, preset, time, weekdays, monthday, unit, amount }} className="backupTaskDialog" closeButton>
    <form onSubmit={submit}>
      <fieldset className="backupTaskFields" disabled={busy}>
        <Field label="Task name"><input autoFocus className="aiKeyInput" required maxLength={80} value={draft.name}
          placeholder="e.g. Nightly research backup" onChange={(e) => patch({ name: e.target.value })} /></Field>
        <Section title="What to back up" />
        <Field label="Workspaces"><Segmented value={draft.scope} onChange={(scope) => patch({ scope })} options={SCOPES} /></Field>
        {draft.scope === "all_owned" ? <p className="settingsPaneHint">Includes new workspaces you own automatically. Each workspace gets its own restorable snapshot.</p> :
          <Field label="Selected workspaces">
            <ToggleGroup selected={draft.workspaces}
              onToggle={(id, on) => patch({ workspaces: on ? [...draft.workspaces, id] : draft.workspaces.filter((w) => w !== id) })}
              options={[
                ...owned.map((w) => [w.id, w.name, null, w.personal ? "Personal workspace" : "Shared workspace"]),
                ...draft.workspaces.filter((id) => !owned.some((w) => w.id === id)).map((id) => [id, "Unavailable workspace", null, "Remove to save"]),
              ]} />
          </Field>}
        <Toggle icon={HardDriveIcon} label="Include uploaded files" checked={draft.uploads} onChange={(uploads) => patch({ uploads })}
          hint="Include PDFs and images alongside notes and chats." />
        <Section title="When to run" />
        <div className="backupTaskGrid">
          <Field label="Frequency"><MenuSelect block label="Frequency" value={preset} onChange={choosePreset} options={FREQUENCIES} /></Field>
          {preset !== "custom" ? <Field label={preset === "hourly" ? "Minute past the hour" : "Time (UTC)"}>
            {preset === "hourly" ? <input className="aiKeyInput" type="number" min="0" max="59" required value={minute}
              onChange={(e) => setTime(`00:${e.target.value.padStart(2, "0")}`)} /> :
              <input className="aiKeyInput" type="time" required value={time} onChange={(e) => setTime(e.target.value)} />}
          </Field> : null}
        </div>
        {preset === "weekly" ? <Field label="Days of the week">
          <ToggleGroup selected={weekdays} options={days}
            onToggle={(day, on) => setWeekdays((prev) => on ? [...prev, day] : prev.filter((d) => d !== day))} />
        </Field> : null}
        {preset === "monthly" ? <Field label="Day of the month" hint="Dates absent from a month are skipped.">
          <input className="aiKeyInput" type="number" min="1" max="31" required value={monthday} onChange={(e) => setMonthday(e.target.value)} />
        </Field> : null}
        {preset === "custom" ? <Field label="Cron expression" hint="Minute · hour · day of month · month · weekday">
          <input className="aiKeyInput backupCron" required value={draft.cron} onChange={(e) => patch({ cron: e.target.value })} placeholder="0 3 * * *" />
        </Field> : null}
        <p className="settingsPaneHint">Schedules use UTC. Preview times below use your local timezone.
          {preset === "custom" ? " Supports * (any), commas, ranges, and steps. Example: 0 9,17 * * 1-5 runs weekdays at 09:00 and 17:00 UTC." : null}</p>
        <div className="backupTaskPreview" aria-live="polite">
          <span className="settingLabel"><ClockIcon size={14} /> Next three runs</span>
          {previewError ? <span className="aiKeysError">{previewError}</span> : preview ?
            <ol>{preview.map((value) => <li key={value}>{date(value)}</li>)}</ol> : <span className="settingDesc">Checking schedule…</span>}
        </div>
        <Section title="Retention" />
        <div className="backupTaskGrid">
          <Field label={unit === "count" ? "Keep latest" : "Keep for"}><input className="aiKeyInput" type="number" required min="1"
            max={Math.floor(3650 / ({ weeks: 7, months: 30 }[unit] || 1))} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Retention unit"><MenuSelect block label="Retention unit" value={unit} onChange={setUnit} options={UNITS} /></Field>
        </div>
        <p className="settingsPaneHint">Only this task’s snapshots expire, after a successful run. The newest snapshot is always kept. Deleting a task keeps its snapshots.</p>
        <Toggle icon={ClockIcon} label="Enable task" checked={draft.enabled} onChange={(enabled) => patch({ enabled })} hint="Paused tasks can still be run manually." />
        {error ? <p className="aiKeysError" role="alert">{error}</p> : null}
        <div className="reportModalBtns">
          <button type="button" className="uiBtn" onClick={onClose}>Cancel</button>
          <button type="submit" className="uiBtn primary" disabled={!preview || !draft.name.trim() || (draft.scope === "selected" && !draft.workspaces.length)}>
            {busy ? "Saving…" : initial?.id ? "Save changes" : "Create task"}
          </button>
        </div>
      </fieldset>
    </form>
  </SubDialog>;
}

export function BackupTasks({ workspaces, confirm, onRefresh }) {
  const [tasks, setTasks] = React.useState(null);
  const [editor, setEditor] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState("");
  const previous = React.useRef("");
  const load = React.useCallback(async () => {
    try {
      const data = await apiJson(endpoint);
      setTasks(data.tasks);
      const signature = JSON.stringify(data.tasks.map((task) => [task.id, task.last_success]));
      if (previous.current && previous.current !== signature) workspaces.forEach((w) => onRefresh(w.id));
      previous.current = signature;
    } catch (e) { setError(e.message); }
  }, [workspaces, onRefresh]);
  React.useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, [load]);

  async function action(task, kind) {
    setBusy(task.id);
    setError("");
    try {
      if (kind === "toggle") await apiJson(`${endpoint}/${task.id}`, json("PUT", { ...task, enabled: !task.enabled }));
      else await apiJson(`${endpoint}/${task.id}${kind === "run" ? "/run" : ""}`, { method: kind === "run" ? "POST" : "DELETE" });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  const owned = workspaces.filter((w) => w.role === "owner");
  return <>
    <Section title="Periodic backup tasks" action={<button className="uiBtn" disabled={!owned.length} onClick={() => setEditor({})}
      title="Runs while the server is on. Missed runs catch up once; failed tasks retry after an hour."><PlusIcon size={14} /> Add task</button>} />
    {error ? <div className="backupTaskError aiKeysError" role="alert">{error}<button className="uiBtn sm" onClick={() => { setError(""); load(); }}>Retry</button></div> : null}
    {tasks === null && !error ? <Empty icon={ClockIcon}>Loading tasks…</Empty> : null}
    {tasks?.length === 0 ? <Empty icon={ClockIcon}>No tasks yet. Add one for a nightly backup, or a schedule of your own.</Empty> : null}
    {!!tasks?.length && <div className="backupTaskTableWrap" role="region" aria-label="Periodic backup tasks" tabIndex={0}>
      <table className="backupTaskTable"><thead><tr><th>Task / Workspaces</th><th>Keep for</th><th>Frequency</th><th>Next run</th><th>Last run</th><th>Enabled</th><th>State</th><th><span className="srOnly">Actions</span></th></tr></thead>
        <tbody>{tasks.map((task) => {
          const names = task.scope === "all_owned" ? "All workspaces I own" : task.workspaces.map((id) => workspaces.find((w) => w.id === id)?.name || "Unavailable workspace").join(", ");
          const running = task.state === "running" || task.state === "queued";
          return <tr key={task.id}>
            <td><strong>{task.name}</strong><span className="settingDesc" title={names}>{names}</span><span className="settingDesc">{task.uploads ? "Includes uploaded files" : "Databases only"}</span></td>
            <td>{task.retention_value}<span className="settingDesc">{task.retention_mode === "count" ? "snapshots" : "days"}</span></td>
            <td><span>{frequency(task.cron)}</span><span className="settingDesc">UTC</span></td>
            <td>{task.requested ? "Queued" : task.enabled ? date(task.next_run) : "Paused"}</td>
            <td>{date(task.last_run)}</td>
            <td><label className="switch"><input type="checkbox" aria-label={`Enable ${task.name}`} checked={task.enabled}
              disabled={running || busy === task.id} onChange={() => action(task, "toggle")} /><span className="switchTrack" /></label></td>
            <td><span className={`uiTag ${task.state}`} title={task.last_error || (task.last_success ? `Last successful: ${date(task.last_success)}` : "No runs yet")}>
              {task.state === "pending" ? "Not run" : task.state}</span></td>
            <td><ActionMenu label={`Actions for ${task.name}`} icon={MoreIcon} iconOnly disabled={running || busy === task.id} items={[
              { label: "Run now", icon: ClockIcon, onClick: () => action(task, "run") },
              { label: "Edit task", icon: DatabaseIcon, onClick: () => setEditor(task) },
              { label: "Duplicate task", icon: PlusIcon, onClick: () => setEditor({ ...task, id: undefined, name: `${task.name} copy` }) },
              { label: "Delete task", icon: Trash2Icon, onClick: () => confirm({ title: "Delete backup task", message: `Delete “${task.name}”? Existing snapshots are kept.`, confirmLabel: "Delete task", danger: true, onConfirm: () => action(task, "delete") }) },
            ]} /></td>
          </tr>;
        })}</tbody></table>
    </div>}
    {tasks?.filter((t) => t.last_error).map((t) => <p key={t.id} className="settingsPaneHint aiKeysError" role="status"><strong>{t.name}:</strong> {t.last_error}{t.enabled ? ` Next attempt: ${date(t.next_run)}.` : ""}</p>)}
    {editor !== null ? <TaskEditor initial={editor.name !== undefined ? editor : null} workspaces={workspaces} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); load(); }} /> : null}
  </>;
}
