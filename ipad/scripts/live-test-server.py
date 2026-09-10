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
    uploaded = client.post("/api/uploads", files={"file": ("coordinates.pdf", pdf, "application/pdf")})
    uploaded.raise_for_status()
    make_page(client, title="Disposable iPad integration PDF", properties={"doc_id": uploaded.json()["doc_id"]})
print("Disposable Gamma ready on loopback 19091", flush=True)
uvicorn.run(app, host="127.0.0.1", port=19091, log_level="warning")
