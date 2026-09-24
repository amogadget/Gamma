// Why opening a server failed, in words a user can act on.
//
// A sidecar that dies during startup used to reach the launcher as a raw tail
// of its log — and since the log file is appended to across runs, that tail was
// usually a dozen irrelevant INFO lines from the last good run with the real
// cause somewhere below. This module answers two questions instead: what
// happened (one sentence plus the server's own wording) and what would fix it
// (`action`, which the launcher turns into a button).

const fs = require('fs');

// `from` is the byte offset the failing run's header was written at, so only
// this run's lines are read back.
function logTail(logPath, from = 0, lines = 60) {
  try {
    const buf = fs.readFileSync(logPath);
    const text = buf.subarray(Math.min(from, buf.length)).toString('utf8');
    return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n') || '(no output)';
  } catch {
    return '(no log)';
  }
}

// First rule whose pattern appears in the log wins; the matched line is kept as
// `detail` so the server still speaks for itself.
const FAILURES = [
  {
    match: /newer than this Gamma/i,
    summary: 'This library was written by a newer version of Gamma.',
    hint: 'Update the app, then open the server again. If you meant to go back to this version, restore the matching snapshot from the backups folder inside the data folder.',
    action: 'update',
  },
  {
    match: /upgrades from \d+ at the earliest/i,
    summary: 'This library is too old for this version of Gamma.',
    hint: 'Open it once with an in-between Gamma release to upgrade its data, then come back here.',
  },
  {
    match: /migration step \d+[^\n]*failed/i,
    summary: 'Upgrading this library’s data failed.',
    hint: 'A snapshot was taken before the upgrade started — the backups folder inside the data folder holds it.',
    action: 'data',
  },
  {
    match: /EADDRINUSE|address already in use/i,
    summary: 'The port the server picked was taken by something else.',
    hint: 'Opening the server again picks a new one.',
    action: 'retry',
  },
  {
    match: /unable to open database file|disk I\/O error|database disk image is malformed/i,
    summary: 'The server could not open its database files.',
    hint: 'Check that the data folder still exists and sits on a drive that is connected — a network or removable disk that went away is the usual cause.',
    action: 'data',
  },
  {
    match: /Permission denied|EACCES|EPERM/i,
    summary: 'The server is not allowed to write to its data folder.',
    hint: 'Check the folder’s permissions, or point local server storage at a folder your account owns.',
    action: 'data',
  },
  {
    match: /ModuleNotFoundError|ImportError|No module named/i,
    summary: 'The server’s Python environment is missing a package.',
    hint: 'In a source checkout: install backend/requirements.txt into the virtualenv the launcher’s advanced settings point at.',
  },
];

// reason: 'exit' (the process quit) or 'timeout' (it never answered /api/health).
function diagnose(log, reason) {
  const lines = String(log || '').split(/\r?\n/);
  for (const rule of FAILURES) {
    const line = lines.find((l) => rule.match.test(l));
    if (line) return { summary: rule.summary, hint: rule.hint, action: rule.action || 'log', detail: line.trim() };
  }
  if (reason === 'timeout') {
    return {
      summary: 'The server started but never answered.',
      hint: 'A slow disk or a security scanner holding up the first launch can do this; opening it again usually works.',
      action: 'retry',
    };
  }
  return {
    summary: 'The server stopped while starting up.',
    hint: 'Its last output is below.',
    action: 'log',
  };
}

// The other way an open fails: the content view could not load the URL at all,
// which arrives as Chromium's own `ERR_…` string. Same treatment — say what
// happened, keep the raw message as the detail.
const OPEN_FAILURES = [
  {
    match: /ERR_NAME_NOT_RESOLVED/,
    summary: 'That address does not exist on this network.',
    hint: 'Check the spelling of the server URL; a machine name that works elsewhere may not resolve from here.',
  },
  {
    match: /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/,
    summary: 'This computer is offline.',
    hint: 'Reconnect and open the server again.',
  },
  {
    match: /ERR_CERT|ERR_SSL/,
    summary: 'The server’s HTTPS certificate was rejected.',
    hint: 'A self-signed certificate will not load here. Use the plain http:// address on a local network, or install a certificate the system trusts.',
  },
  {
    match: /ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/,
    summary: 'Gamma could not reach this server.',
    hint: 'It may be switched off, or the address may be wrong — check that the machine is running Gamma and is reachable from here.',
  },
];

function diagnoseOpen(message) {
  const text = String(message || '');
  for (const rule of OPEN_FAILURES) {
    if (rule.match.test(text)) return { summary: rule.summary, hint: rule.hint, action: 'retry', detail: text };
  }
  return { summary: 'Could not open this server.', hint: '', action: 'retry', detail: text };
}

// An Error carrying what the launcher needs. The message stays readable on its
// own, for the console and for anything that only has a string.
function startupError(reason, logPath, from) {
  const log = logTail(logPath, from);
  const d = diagnose(log, reason);
  const err = new Error(`${d.summary} ${d.hint || ''}`.trim());
  err.startup = { ...d, log };
  return err;
}

module.exports = { diagnose, diagnoseOpen, startupError };
