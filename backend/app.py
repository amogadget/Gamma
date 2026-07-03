"""Uvicorn entrypoint: `uvicorn app:app` from the backend/ directory.

The application lives in the gamma package; see gamma/app.py.
"""

from gamma.app import app  # noqa: F401
