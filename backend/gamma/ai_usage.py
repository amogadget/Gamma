"""Token usage bookkeeping: one ``ai_usage`` row in users.db per AI call an
account makes (chat turn, translation batch, metadata extraction, …), and
the summary Settings → AI shows. Counts come from the providers' own
reports (``ai_client.normalize_usage``); a provider that reports nothing
leaves no row. Costs are deliberately not estimated — prices differ per
provider and change; the tokens are what every provider agrees on."""

import sqlite3
from datetime import datetime, timedelta, timezone

from .db import connect_users_db, page_now
from .logbuf import log

KINDS = ("chat", "translate", "metadata", "cite", "test")
_FIELDS = ("input", "output", "cache_read", "cache_write")
# Rows older than this are dropped on the next write (the summary's longest
# window is 30 days; a year keeps the all-time total honest for a while).
KEEP_DAYS = 400


def record(username: str, kind: str, provider_id: str, provider_name: str,
           model: str, usage: dict | None) -> None:
    """Store one call's token counts. Never raises — usage is a courtesy,
    not something a failing insert should turn into a failed chat."""
    if not usage or not username or kind not in KINDS:
        return
    counts = [max(0, int(usage.get(f) or 0)) for f in _FIELDS]
    if not any(counts):
        return
    try:
        with connect_users_db() as conn:
            conn.execute(
                "INSERT INTO ai_usage (username, at, kind, provider_id, provider_name, model, "
                "input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (username, page_now(), kind, str(provider_id or "")[:64],
                 str(provider_name or "")[:80], str(model or "")[:120], *counts))
            cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
            conn.execute("DELETE FROM ai_usage WHERE username = ? AND at < ?", (username, cutoff))
    except sqlite3.Error as e:
        log.warning(f"[ai_usage] could not record usage: {e}")


def recorder(kind: str, entry: dict, runtime: dict):
    """An ``on_usage`` callback for ``ai_client`` bound to one call site:
    the runtime (``ai_settings.ai_runtime``) names the account, the model
    registry entry the provider and model."""
    if not isinstance(entry, dict):  # a bare model id (tests stub the resolver so)
        entry = {"model": str(entry or "")}
    username = runtime.get("user") or ""
    conf = (runtime.get("providers") or {}).get(entry.get("provider"), {})

    def on_usage(usage):
        record(username, kind, entry.get("provider", ""), conf.get("name", ""),
               entry.get("model", ""), usage)
    return on_usage


def _empty() -> dict:
    return {"calls": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0}


def _totals(rows) -> dict:
    total = _empty()
    for row in rows:
        total["calls"] += 1
        for f in _FIELDS:
            total[f] += row[f]
    return total


def summary(username: str) -> dict:
    """The Settings pane's numbers: totals over today / 7 days / 30 days /
    everything kept, the 30-day split by kind, and the 30-day split by
    model (provider name + model id, biggest first)."""
    with connect_users_db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT at, kind, provider_id, provider_name, model, input, output, cache_read, cache_write "
            "FROM ai_usage WHERE username = ? ORDER BY at DESC", (username,)).fetchall()
    now = datetime.now(timezone.utc)
    day_start = now.strftime("%Y-%m-%dT00:00:00")
    since = {"today": day_start,
             "week": (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S"),
             "month": (now - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")}
    windows = {name: _totals(r for r in rows if r["at"] >= start) for name, start in since.items()}
    windows["all"] = _totals(rows)
    month_rows = [r for r in rows if r["at"] >= since["month"]]
    kinds: dict = {}
    models: dict = {}
    for r in month_rows:
        k = kinds.setdefault(r["kind"], _empty())
        m = models.setdefault((r["provider_id"], r["model"]),
                              {"provider_id": r["provider_id"], "provider_name": r["provider_name"],
                               "model": r["model"], **_empty()})
        for bucket in (k, m):
            bucket["calls"] += 1
            for f in _FIELDS:
                bucket[f] += r[f]
    return {
        "windows": windows,
        "kinds": kinds,
        "models": sorted(models.values(), key=lambda m: -(m["input"] + m["output"])),
        "first_at": rows[-1]["at"] if rows else "",
        "keep_days": KEEP_DAYS,
    }


def clear(username: str) -> int:
    """Drop the account's usage rows; returns how many went."""
    with connect_users_db() as conn:
        cur = conn.execute("DELETE FROM ai_usage WHERE username = ?", (username,))
        return cur.rowcount
