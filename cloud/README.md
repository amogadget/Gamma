# Gamma Cloud account server

The service behind `account.gammapdf.com`: accounts, the sign-in portal,
and the OpenID Connect provider every Gamma server (a desktop sidecar, the
free share host, a paid container) signs people in through. It holds no
notes or files and imports nothing from `backend/`.

Architecture and the full reference: [docs/dev/cloud_accounts.md](../docs/dev/cloud_accounts.md).
The product plan it serves: [todos/gamma-cloud-plan.md](../todos/gamma-cloud-plan.md).

```bash
pip install -r requirements.txt -r requirements-dev.txt
python manage.py setup
python manage.py create-account you@example.org you --admin --verified
uvicorn app:app --port 9002 --reload      # portal at http://127.0.0.1:9002
python -m pytest tests -q
```

Configuration is `GAMMA_CLOUD_*` env variables, documented at the top of
[gammacloud/config.py](gammacloud/config.py). With the defaults (registration
by invite, mail to the console) `python manage.py invite` prints a code
and the verify link appears in the server log.
