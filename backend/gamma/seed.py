"""Per-user database creation and guest seeding.

Shared by the app (daily guest reset) and manage.py (user CRUD) so the
welcome page and schemas never drift between the two.
"""

import secrets
import shutil
import sqlite3
from contextlib import closing

from fractional_indexing import generate_key_between

from .config import USERS_DIR
from .db import DATA_SCHEMA, PAGES_SCHEMA, connect_users_db, page_now

# GitHub raw base for screenshots embedded in the guest welcome page.
_SCREENSHOTS = "https://raw.githubusercontent.com/tim4431/Gamma/main/docs/screenshots"


def _welcome_blocks():
    """Nested welcome page seeded into fresh guest workspaces."""
    wid = secrets.token_urlsafe(9)
    started_id = secrets.token_urlsafe(9)
    figures_id = secrets.token_urlsafe(9)
    guest_id = secrets.token_urlsafe(9)
    md_id = secrets.token_urlsafe(9)
    return [
        (wid, "root", "a0V", "Welcome", '{"summary":"A quick-start guide to Gamma PDF Annotator"}'),
        (secrets.token_urlsafe(9), wid, "a0", "Gamma is a self-hosted, Logseq-inspired PDF annotation tool. You can highlight PDFs, organize notes as nested outliner blocks, and share read-only annotated copies via link.", '{}'),
        (started_id, wid, generate_key_between("a0", None), "## Getting started", '{}'),
        (secrets.token_urlsafe(9), started_id, "a0", "**Open a PDF**: paste a URL in the topbar and click Open, or drag a PDF file onto this page.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a0", None), "**Highlight text**: select text in the PDF to create a highlight with optional comment and color.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a0V", None), "**Add notes**: type in any block. Press Enter for a new sibling, Tab to indent, Shift+Tab to outdent.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a1", None), "**Reorder blocks**: hover over a block's left edge, grab the ⋮⋮ handle, and drag to reorder.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a1V", None), "**Drag images**: drag an image file from your computer onto any block to insert it. You can also paste images from the clipboard.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a2", None), "**AI chat**: click \"Show AI Chat\" at the bottom of the sidebar to ask questions about the open PDF.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a2V", None), "**Share**: click \"Share link\" in the ⋮ menu to generate a public read-only link for any annotated PDF.", '{}'),
        (secrets.token_urlsafe(9), started_id, generate_key_between("a3", None), "**Category tags**: add a `category::` tag below the summary to organize pages. The home page groups them into carousels.", '{}'),
        (figures_id, wid, generate_key_between("a0V", None), "## Insert figures", '{}'),
        (secrets.token_urlsafe(9), figures_id, "a0", "Drag any image file into a block to embed it. Gamma uploads it and inserts `![]()` markdown. Here is what the app looks like:", '{}'),
        (secrets.token_urlsafe(9), figures_id, generate_key_between("a0", None), f"![]({_SCREENSHOTS}/01-annotated-pdf.png)", '{}'),
        (secrets.token_urlsafe(9), figures_id, generate_key_between("a0V", None), f"![]({_SCREENSHOTS}/02-home-carousels.png)", '{}'),
        (guest_id, wid, generate_key_between("a1", None), "## Guest account", '{}'),
        (secrets.token_urlsafe(9), guest_id, "a0", "You are logged in as a **guest**. Your data resets each day at midnight UTC. To keep your work permanently, ask the admin to create an account for you.", '{}'),
        (md_id, wid, generate_key_between("a1V", None), "## Markdown formatting", '{}'),
        (secrets.token_urlsafe(9), md_id, "a0", "Blocks support **bold**, *italic*, `code`, [links](https://example.com), and inline $\\KaTeX$ math like $E = mc^2$.", '{}'),
    ]


def create_user_dbs(username: str):
    """Create fresh pages.db, data.db, and uploads/ for a user.

    Guest gets the welcome page seeded into pages.db.
    """
    user_dir = USERS_DIR / username
    user_dir.mkdir(parents=True, exist_ok=True)
    nw = page_now()

    # closing(), not just the context manager: sqlite3's `with` commits but
    # does NOT close, and the open handle would block renaming/deleting the
    # user directory on Windows (manage.py rename-user right after create).
    with closing(sqlite3.connect(str(user_dir / "pages.db"))) as pages_db:
        for stmt in PAGES_SCHEMA:
            pages_db.execute(stmt)
        if not pages_db.execute("SELECT 1 FROM unified_blocks WHERE id = 'root'").fetchone():
            pages_db.execute(
                "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                "VALUES ('root', NULL, 'a0', '', '{}', ?, ?)",
                (nw, nw),
            )
        if username == "guest":
            for bid, pid, pos, content, props in _welcome_blocks():
                pages_db.execute(
                    "INSERT INTO unified_blocks (id, parent_id, position, content, properties, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (bid, pid, pos, content, props or "{}", nw, nw),
                )
        pages_db.commit()

    with closing(sqlite3.connect(str(user_dir / "data.db"))) as data_db:
        for stmt in DATA_SCHEMA:
            data_db.execute(stmt)
        data_db.commit()

    (user_dir / "uploads").mkdir(parents=True, exist_ok=True)


def reset_guest_data():
    """Wipe the guest workspace and recreate it with the welcome page."""
    guest_dir = USERS_DIR / "guest"
    if guest_dir.exists():
        shutil.rmtree(str(guest_dir))
    create_user_dbs("guest")


def ensure_guest_user():
    """Make sure the guest account row exists in users.db."""
    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'guest'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES ('guest', '', 1, ?)",
                (page_now(),),
            )
            conn.commit()
