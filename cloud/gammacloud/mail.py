"""Outgoing mail: the verify, reset and change-email links. One function,
three backends chosen by ``GAMMA_CLOUD_MAIL``: ``console`` logs the message
(development), ``smtp`` sends it, ``memory`` keeps it in ``outbox`` (tests).
Every message is multipart: the plain text plus an HTML alternative built by
``compose`` in the portal's palette (table layout and inline styles, since
mail clients drop ``<style>`` and SVG)."""

import html as _html
import smtplib
from email.message import EmailMessage

from . import config
from .log import log

outbox: list[dict] = []


class MailError(RuntimeError):
    pass


def compose(greeting: str, paragraphs: list[str], button: tuple[str, str] | None = None,
            footer: str = "") -> tuple[str, str]:
    """The (text, html) bodies of one message: a greeting, a few plain
    paragraphs, an optional call-to-action ``(label, url)`` shown as a button
    with the raw link under it, and a muted footer line."""
    esc = lambda s: _html.escape(s, quote=True)  # noqa: E731
    text = [greeting, *paragraphs]
    if button:
        text.append(f"{button[0]}:\n{button[1]}")
    if footer:
        text.append(footer)
    text_body = "\n\n".join(text) + "\n\n— Gamma Cloud\n"

    p = "margin:0 0 16px;font-size:15px;line-height:1.55;color:#1f1e1b"
    parts = [f'<p style="{p};font-weight:600">{esc(greeting)}</p>']
    parts += [f'<p style="{p}">{esc(s)}</p>' for s in paragraphs]
    if button:
        label, url = map(esc, button)
        parts.append(
            '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>'
            f'<td style="border-radius:6px;background:#1e1e1c"><a href="{url}" '
            'style="display:inline-block;padding:11px 20px;font-size:15px;font-weight:600;color:#eeebe4;'
            f'text-decoration:none;border-radius:6px">{label}</a></td></tr></table>'
            '<p style="margin:0 0 6px;font-size:13px;color:#8a877e">Or paste this link into your browser:</p>'
            f'<p style="margin:0 0 16px;font-size:13px;word-break:break-all"><a href="{url}" '
            f'style="color:#9a6206">{url}</a></p>')
    foot = (f'<p style="margin:0;font-size:13px;line-height:1.5;color:#8a877e">{esc(footer)}</p>'
            if footer else "")
    preheader = esc(paragraphs[0] if paragraphs else greeting)
    html_body = (
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        '<meta name="color-scheme" content="light"></head>'
        '<body style="margin:0;padding:0;background:#f7f6f3">'
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0">{preheader}</div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3">'
        '<tr><td align="center" style="padding:32px 16px">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="max-width:520px;font-family:Inter,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">'
        '<tr><td style="padding:0 4px 16px;font-size:16px;font-weight:600;color:#1f1e1b">'
        '<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#e8a020;'
        'margin-right:8px"></span>Gamma <span style="color:#e8a020;font-weight:500">Cloud</span></td></tr>'
        '<tr><td style="background:#ffffff;border:1px solid #e6e3db;border-radius:8px;padding:28px 28px 24px">'
        f'{"".join(parts)}{foot}</td></tr>'
        '<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:#8a877e">'
        f'Sent by Gamma Cloud · <a href="{esc(config.PUBLIC_URL)}" style="color:#8a877e">'
        f'{esc(config.PUBLIC_URL.split("://", 1)[-1])}</a></td></tr>'
        '</table></td></tr></table></body></html>')
    return text_body, html_body


def send(to: str, subject: str, body: str, html: str = "") -> None:
    backend = config.MAIL_BACKEND
    if backend == "memory":
        outbox.append({"to": to, "subject": subject, "body": body, "html": html})
        return
    if backend == "console":
        log.info("mail to %s: %s\n%s", to, subject, body)
        return
    if backend != "smtp":
        raise MailError(f"unknown mail backend {backend!r}")
    if not config.SMTP_HOST:
        raise MailError("GAMMA_CLOUD_SMTP_HOST is not set")
    msg = EmailMessage()
    msg["From"] = config.MAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    try:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=20) as smtp:
            if config.SMTP_STARTTLS:
                smtp.starttls()
            if config.SMTP_USER:
                smtp.login(config.SMTP_USER, config.SMTP_PASSWORD)
            smtp.send_message(msg)
    except (smtplib.SMTPException, OSError) as e:
        log.warning("mail to %s failed: %s", to, e)
        raise MailError(str(e)) from e
