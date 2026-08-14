#!/usr/bin/env python3
"""Seed a notes-heavy page (30 note blocks) and print its block id.

Used by run.sh so the notes-position-restore test has a scrollable sidebar.
Runs with the backend venv's python (needs httpx).
"""
import os

import httpx

BASE = os.environ["BASE_URL"]
USER = os.environ.get("ADMIN_USER", "admin")
PASS = os.environ.get("ADMIN_PASS", "smoke-pass-123")

c = httpx.Client(base_url=BASE)
r = c.post("/api/login", json={"username": USER, "password": PASS})
r.raise_for_status()

page = c.post("/api/blocks", json={"parent_id": "root", "content": "Notes Test"}).json()
pos = None
for i in range(1, 31):
    r = c.post("/api/blocks", json={"parent_id": page["id"], "content": f"note {i}", "after": pos})
    pos = r.json()["position"]

print(page["id"])
