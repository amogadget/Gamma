"""Disposable loopback Gamma backend for the opt-in Apple framework integration test.
Never uses production data. Run from repository root with backend/venv/bin/python.
"""
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "backend/tests"))
# Test bootstrap creates a unique GAMMA_DATA_DIR before Gamma is imported.
from conftest import make_user, login, make_page  # noqa: E402
from gamma.app import app  # noqa: E402
import uvicorn  # noqa: E402

make_user("ipad-integration", "disposable-test-password")
with login("ipad-integration", "disposable-test-password") as client:
    import runpy
    pdf = runpy.run_path(str(repo / "ipad/scripts/make-coordinate-fixture.py"))["make_pdf"]()
    def seed_pdf(workspace, title):
        client.headers["X-Gamma-Workspace"] = workspace
        pages = client.get("/api/blocks/root/children")
        pages.raise_for_status()
        matches = [page for page in pages.json()["children"] if page["content"] == title]
        if len(matches) > 1:
            raise RuntimeError(f"Duplicate seed pages named {title!r}")
        uploaded = client.post("/api/uploads", files={"file": ("coordinates.pdf", pdf, "application/pdf")})
        uploaded.raise_for_status()
        properties = {"doc_id": uploaded.json()["doc_id"]}
        if matches:
            updated = client.put(f"/api/blocks/{matches[0]['id']}", json={"properties": properties})
            updated.raise_for_status()
        else:
            make_page(client, title=title, properties=properties)

    session = client.get("/api/session")
    session.raise_for_status()
    info = session.json()
    default = info["default_workspace"]
    name = "Native QA second library"
    matches = [ws for ws in info["workspaces"] if ws["name"] == name]
    if len(matches) > 1:
        raise RuntimeError(f"Duplicate workspaces named {name!r}")
    if matches:
        second = matches[0]["id"]
    else:
        created = client.post("/api/workspaces", json={"name": name})
        created.raise_for_status()
        second = created.json()["id"]
    if second == default:
        raise RuntimeError("The isolation fixture must not be the default workspace")
    seed_pdf(default, "Disposable iPad integration PDF")
    seed_pdf(second, "Native QA second library PDF")
    client.headers.pop("X-Gamma-Workspace", None)
print("Disposable Gamma ready on loopback 19091", flush=True)
uvicorn.run(app, host="127.0.0.1", port=19091, log_level="warning")
