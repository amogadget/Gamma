"""Outgoing mail: the verify, reset and change-email links. One function,
three backends chosen by ``GAMMA_CLOUD_MAIL``: ``console`` logs the message
(development), ``smtp`` sends it, ``memory`` keeps it in ``outbox`` (tests).
Messages are plain text; nothing in the plan needs HTML mail."""

import smtplib
from email.message import EmailMessage

from . import config
from .log import log

outbox: list[dict] = []


class MailError(RuntimeError):
    pass


def send(to: str, subject: str, body: str) -> None:
    backend = config.MAIL_BACKEND
    if backend == "memory":
        outbox.append({"to": to, "subject": subject, "body": body})
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
