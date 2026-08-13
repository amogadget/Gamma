"""Provider-agnostic AI transport and provider wire-format adapters.

This module owns the HTTP request/response details for Anthropic Messages,
OpenAI Chat Completions, and ChatGPT's Responses API.  Route handlers should
deal in the common ``messages`` representation and call :func:`call_ai` or
:func:`open_ai`; provider-specific shapes stay here.
"""

import json
import urllib.error
import urllib.request
import uuid

from .logbuf import log


def anthropic_request(
    conf,
    messages,
    system,
    model,
    pdf_b64s=None,
    effort="",
    max_tokens=8192,
    images=None,
    stream=False,
):
    """Build an Anthropic Messages API request."""
    if pdf_b64s or images:
        last = messages[-1]
        last["content"] = [
            *[
                {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": data,
                    },
                }
                for data in (pdf_b64s or [])
            ],
            *[
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": data},
                }
                for media_type, data in (images or [])
            ],
            {"type": "text", "text": last["content"]},
        ]
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    if effort:
        body["output_config"] = {"effort": effort}
    if stream:
        body["stream"] = True
    return urllib.request.Request(
        f"{conf['base_url']}/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "x-api-key": conf["api_key"],
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )


def _anthropic_extract(data) -> str:
    text = "".join(item.get("text", "") for item in data.get("content", []) if item.get("type") == "text")
    if not text.strip():
        raise RuntimeError(f"empty response (stop_reason={data.get('stop_reason', 'unknown')})")
    return text


def openai_request(
    conf,
    messages,
    system,
    model,
    pdf_b64s=None,
    effort="",
    max_tokens=8192,
    images=None,
    stream=False,
):
    """Build an OpenAI Chat Completions API request."""
    if pdf_b64s or images:
        last = messages[-1]
        last["content"] = [
            *[
                {
                    "type": "file",
                    "file": {
                        "filename": f"document-{index + 1}.pdf",
                        "file_data": f"data:application/pdf;base64,{data}",
                    },
                }
                for index, data in enumerate(pdf_b64s or [])
            ],
            *[
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{media_type};base64,{data}"},
                }
                for media_type, data in (images or [])
            ],
            {"type": "text", "text": last["content"]},
        ]
    if system:
        messages = [{"role": "system", "content": system}] + messages
    body = {
        "model": model,
        # Current OpenAI models use max_completion_tokens. The cap includes
        # hidden reasoning tokens, so leave a generous default.
        "max_completion_tokens": max_tokens,
        "messages": messages,
    }
    if effort:
        body["reasoning_effort"] = effort
    if stream:
        body["stream"] = True
    return urllib.request.Request(
        f"{conf['base_url']}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {conf['api_key']}",
            "Content-Type": "application/json",
        },
    )


def _openai_extract(data) -> str:
    choices = data.get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content") or ""
    if not text.strip():
        reason = choices[0].get("finish_reason", "unknown")
        raise RuntimeError(
            f"empty response (finish_reason={reason} — a reasoning model may have spent "
            "the whole token budget thinking; try effort: low or a shorter request)"
        )
    return text


def chatgpt_request(
    conf,
    messages,
    system,
    model,
    pdf_b64s=None,
    effort="",
    max_tokens=8192,
    images=None,
    stream=False,
):
    """Build a ChatGPT subscription Responses API request.

    The backend only streams SSE, including for callers that want a complete
    reply.  :func:`read_reply` joins those deltas for non-stream callers.
    """
    items = []
    for message in messages:
        if message["role"] == "assistant":
            content = [{"type": "output_text", "text": message["content"]}]
            items.append({"type": "message", "role": "assistant", "content": content})
        else:
            content = [{"type": "input_text", "text": message["content"]}]
            items.append({"type": "message", "role": "user", "content": content})
    if pdf_b64s or images:
        last = items[-1]
        last["content"] = [
            *[
                {
                    "type": "input_file",
                    "filename": f"document-{index + 1}.pdf",
                    "file_data": f"data:application/pdf;base64,{data}",
                }
                for index, data in enumerate(pdf_b64s or [])
            ],
            *[
                {"type": "input_image", "image_url": f"data:{media_type};base64,{data}"}
                for media_type, data in (images or [])
            ],
            *last["content"],
        ]
    body = {
        "model": model,
        "instructions": system or "You are a helpful research assistant.",
        "input": items,
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "store": False,
        "stream": True,
        "include": [],
    }
    if effort:
        body["reasoning"] = {"effort": effort}
    return urllib.request.Request(
        f"{conf['base_url']}/responses",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {conf['api_key']}",
            "chatgpt-account-id": conf.get("account_id", ""),
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "session_id": str(uuid.uuid4()),
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        },
    )


_WIRE = {
    "anthropic": (anthropic_request, _anthropic_extract),
    "openai": (openai_request, _openai_extract),
    "chatgpt": (chatgpt_request, None),
}


def protocol(runtime, entry) -> str:
    """Return the wire protocol for a model registry entry."""
    return runtime["providers"][entry["provider"]]["protocol"]


class UpstreamError(RuntimeError):
    """Provider HTTP error with the status attached for fallback decisions."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def upstream_detail(error: urllib.error.HTTPError, cap: int = 500) -> str:
    """Return an actionable provider failure including its response body."""
    body = ""
    try:
        body = error.read().decode("utf-8", "replace")[:cap]
    except Exception:
        pass
    return f"upstream {error.code}: {body or error.reason}"


def open_ai(
    messages,
    system,
    entry,
    runtime,
    pdf_b64s=None,
    effort="",
    max_tokens=8192,
    timeout=60,
    images=None,
    stream=False,
):
    """Open a provider call without consuming response bytes."""
    conf = runtime["providers"][entry["provider"]]
    build_request = _WIRE[conf["protocol"]][0]
    request = build_request(
        conf,
        messages,
        system,
        entry["model"],
        pdf_b64s,
        effort,
        max_tokens,
        images,
        stream,
    )
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        detail = upstream_detail(error)
        log.warning(f"[ai] {detail}")
        raise UpstreamError(error.code, detail)


def read_reply(response, provider_protocol) -> str:
    """Read the full reply text from an open provider response."""
    if provider_protocol == "chatgpt":
        return "".join(sse_deltas(response, provider_protocol))
    return _WIRE[provider_protocol][1](json.loads(response.read()))


def call_ai(
    messages,
    system,
    entry,
    runtime,
    pdf_b64s=None,
    effort="",
    max_tokens=8192,
    timeout=60,
    images=None,
):
    """Send a chat and return its complete reply text."""
    with open_ai(
        messages,
        system,
        entry,
        runtime,
        pdf_b64s,
        effort,
        max_tokens,
        timeout,
        images,
    ) as response:
        return read_reply(response, protocol(runtime, entry))


def sse_deltas(response, provider_protocol):
    """Yield text deltas from a provider's SSE response."""
    got_text = False
    stop = ""
    for raw in response:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            event = json.loads(data)
        except ValueError:
            continue
        if provider_protocol == "anthropic":
            kind = event.get("type")
            if kind == "content_block_delta":
                text = (event.get("delta") or {}).get("text") or ""
                if text:
                    got_text = True
                    yield text
            elif kind == "message_delta":
                stop = (event.get("delta") or {}).get("stop_reason") or stop
            elif kind == "error":
                raise RuntimeError((event.get("error") or {}).get("message") or "stream error")
        elif provider_protocol == "chatgpt":
            kind = event.get("type") or ""
            if kind == "response.output_text.delta":
                text = event.get("delta") or ""
                if text:
                    got_text = True
                    yield text
            elif kind == "response.completed":
                stop = (event.get("response") or {}).get("status") or "completed"
            elif kind in ("response.failed", "error"):
                error = (event.get("response") or {}).get("error") or {} if kind == "response.failed" else event
                raise RuntimeError(error.get("message") or "stream error")
        else:
            if event.get("error"):
                raise RuntimeError((event["error"] or {}).get("message") or "stream error")
            choice = (event.get("choices") or [{}])[0]
            text = (choice.get("delta") or {}).get("content") or ""
            if text:
                got_text = True
                yield text
            stop = choice.get("finish_reason") or stop
    if not got_text:
        raise RuntimeError(
            f"empty response (stop reason={stop or 'unknown'} — a reasoning model may have spent "
            "the whole token budget thinking; try effort: low or a shorter request)"
        )
