"""uvicorn entry: ``uvicorn app:app --port 9002`` from ``cloud/``."""

from gammacloud.app import create_app

app = create_app()
