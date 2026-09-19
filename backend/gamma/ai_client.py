"""Provider-agnostic AI transport and provider wire-format adapters.

This module owns the HTTP request/response details for Anthropic Messages,
OpenAI Chat Completions, and ChatGPT's Responses API.  Route handlers should
deal in the common ``messages`` representation and call :func:`call_ai` or
:func:`open_ai`; provider-specific shapes stay here.
"""

import json
import re
import urllib.error
import urllib.request
import uuid

from .logbuf import log


# Tools are declared once in a common shape ({name, description, parameters})
# — see gamma/ai_tools.py — and translated per wire protocol here. Messages may
# carry two agentic extensions beyond {role, content-str}: an assistant message
# with `tool_calls` ([{id, name, arguments-dict}]) and a {"role": "tool",
# "call_id", "content"} result entry; each builder maps them to its wire shape.

def _attach_index(messages) -> int:
    """Index of the message attachments ride on: the last plain user turn
    (tool-result entries can follow it in agent rounds)."""
    for index in range(len(messages) - 1, -1, -1):
        if messages[index]["role"] == "user":
            return index
    return len(messages) - 1


def anthropic_request(
    conf, messages, system, model, pdf_b64s=None, effort="",
    max_tokens=8192, images=None, stream=False, tools=None,
):
    """Build an Anthropic Messages API request."""
    messages = [dict(m) for m in messages]  # attachment injection must not mutate the caller's turn list
    if pdf_b64s or images:
        last = messages[_attach_index(messages)]
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
        "messages": _anthropic_messages(messages),
    }
    if tools:
        body["tools"] = [{"name": t["name"], "description": t["description"],
                          "input_schema": t["parameters"]} for t in tools]
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


def _anthropic_messages(messages) -> list:
    """Map the common turn list to Anthropic content blocks: tool results are
    tool_result blocks in a user turn (consecutive ones coalesced — they must
    directly follow the assistant's tool_use turn), tool calls become tool_use
    blocks after the assistant's text."""
    out = []
    for m in messages:
        if m["role"] == "tool":
            block = {"type": "tool_result", "tool_use_id": m["call_id"], "content": m["content"]}
            prev = out[-1] if out else None
            if (prev and prev["role"] == "user" and isinstance(prev["content"], list)
                    and prev["content"] and prev["content"][0].get("type") == "tool_result"):
                prev["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
        elif m["role"] == "assistant" and m.get("tool_calls"):
            content = [{"type": "text", "text": m["content"]}] if (m.get("content") or "").strip() else []
            content += [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["arguments"]}
                        for c in m["tool_calls"]]
            out.append({"role": "assistant", "content": content})
        else:
            prev = out[-1] if out else None
            if (m["role"] == "user" and prev and prev["role"] == "user"
                    and isinstance(prev["content"], list)
                    and prev["content"] and prev["content"][0].get("type") == "tool_result"):
                # A tool-only assistant reply leaves its results as the last
                # user turn; fold the next real user message into it so roles
                # keep alternating. Attachment turns already carry block lists.
                prev["content"].extend(
                    m["content"] if isinstance(m["content"], list)
                    else [{"type": "text", "text": m["content"]}])
            else:
                out.append({"role": m["role"], "content": m["content"]})
    return out


def _anthropic_extract(data) -> str:
    text = "".join(
        item.get("text", "")
        for item in data.get("content", [])
        if item.get("type") == "text"
    )
    if not text.strip():
        raise RuntimeError(f"empty response (stop_reason={data.get('stop_reason', 'unknown')})")
    return text


def openai_request(
    conf, messages, system, model, pdf_b64s=None, effort="",
    max_tokens=8192, images=None, stream=False, tools=None,
):
    """Build an OpenAI Chat Completions API request."""
    messages = [dict(m) for m in messages]
    if pdf_b64s or images:
        last = messages[_attach_index(messages)]
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
    wire = [{"role": "system", "content": system}] if system else []
    for m in messages:
        if m["role"] == "tool":
            wire.append({"role": "tool", "tool_call_id": m["call_id"], "content": m["content"]})
        elif m["role"] == "assistant" and m.get("tool_calls"):
            wire.append({"role": "assistant", "content": m.get("content") or None,
                         "tool_calls": [{"id": c["id"], "type": "function",
                                         "function": {"name": c["name"],
                                                      "arguments": json.dumps(c["arguments"])}}
                                        for c in m["tool_calls"]]})
        else:
            wire.append({"role": m["role"], "content": m["content"]})
    body = {
        "model": model,
        # Current OpenAI models use max_completion_tokens. The cap includes
        # hidden reasoning tokens, so leave a generous default.
        "max_completion_tokens": max_tokens,
        "messages": wire,
    }
    if tools:
        body["tools"] = [{"type": "function",
                          "function": {"name": t["name"], "description": t["description"],
                                       "parameters": t["parameters"]}} for t in tools]
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


def _responses_input(messages, pdf_b64s=None, images=None) -> list:
    """Map the common turn list to Responses API input items (shared by the
    ChatGPT/codex backend and OpenAI's platform /v1/responses)."""
    items = []
    for message in messages:
        if message["role"] == "tool":
            items.append({"type": "function_call_output", "call_id": message["call_id"],
                          "output": message["content"]})
        elif message["role"] == "assistant":
            if message.get("content") or not message.get("tool_calls"):
                content = [{"type": "output_text", "text": message["content"]}]
                items.append({"type": "message", "role": "assistant", "content": content})
            for call in message.get("tool_calls") or []:
                items.append({"type": "function_call", "call_id": call["id"],
                              "name": call["name"], "arguments": json.dumps(call["arguments"])})
        else:
            content = [{"type": "input_text", "text": message["content"]}]
            items.append({"type": "message", "role": "user", "content": content})
    if pdf_b64s or images:
        last = next((item for item in reversed(items)
                     if item.get("type") == "message" and item.get("role") == "user"), items[-1])
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
    return items


def _responses_tools(tools) -> list:
    # Responses API uses a flattened function-tool shape (no "function" nesting).
    return [{"type": "function", "name": t["name"], "description": t["description"],
             "parameters": t["parameters"], "strict": False} for t in (tools or [])]


def chatgpt_request(
    conf, messages, system, model, pdf_b64s=None, effort="",
    max_tokens=8192, images=None, stream=False, tools=None,
):
    """Build a ChatGPT subscription Responses API request.

    The backend only streams SSE, including for callers that want a complete
    reply.  :func:`read_reply` joins those deltas for non-stream callers.
    """
    body = {
        "model": model,
        "instructions": system or "You are a helpful research assistant.",
        "input": _responses_input(messages, pdf_b64s, images),
        "tools": _responses_tools(tools),
        "tool_choice": "auto",
        # Batched calls (e.g. renaming a whole folder in one round) — a call
        # per round-trip would eat the tool-round budget one page at a time.
        "parallel_tool_calls": bool(tools),
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


def openai_responses_request(
    conf, messages, system, model, pdf_b64s=None, effort="",
    max_tokens=8192, images=None, stream=False, tools=None,
):
    """Build an OpenAI platform /v1/responses request.

    Used instead of Chat Completions when a call carries function tools:
    reasoning models (gpt-5.x) reject tools + reasoning_effort on
    /v1/chat/completions and OpenAI's guidance is to use the Responses API.
    Always streamed — the tool loop consumes SSE on every protocol.
    """
    body = {
        "model": model,
        "input": _responses_input(messages, pdf_b64s, images),
        "tools": _responses_tools(tools),
        "tool_choice": "auto",
        "parallel_tool_calls": bool(tools),
        "store": False,
        "stream": True,
        "max_output_tokens": max_tokens,
    }
    if system:
        body["instructions"] = system
    if effort:
        body["reasoning"] = {"effort": effort}
    return urllib.request.Request(
        f"{conf['base_url']}/v1/responses",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {conf['api_key']}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        },
    )


_WIRE = {
    "anthropic": (anthropic_request, _anthropic_extract),
    "openai": (openai_request, _openai_extract),
    "openai-responses": (openai_responses_request, None),
    "chatgpt": (chatgpt_request, None),
}


def protocol(runtime, entry) -> str:
    """Return the wire protocol for a model registry entry."""
    return runtime["providers"][entry["provider"]]["protocol"]


def wire_protocol(runtime, entry, tools=None) -> str:
    """The wire dialect a call actually uses. OpenAI-protocol calls that carry
    function tools go over the platform Responses API (reasoning models reject
    tools on chat completions) — but only against the official endpoint:
    OpenAI-compatible gateways behind a custom base URL may not implement
    /v1/responses, and chat-completions tools still work there."""
    conf = runtime["providers"][entry["provider"]]
    if (tools and conf["protocol"] == "openai"
            and conf["base_url"].startswith("https://api.openai.com")):
        return "openai-responses"
    return conf["protocol"]


class UpstreamError(RuntimeError):
    """Provider HTTP error with the status attached for fallback decisions."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _summarize_error_body(body: str) -> str:
    """The human-readable core of a provider error body: JSON errors reduce
    to their message field, HTML error pages (a proxy's 502 page) to their
    <title> — never the raw markup, which is noise in any UI."""
    text = (body or "").strip()
    if re.match(r"(?i)<(!doctype|html|head|body)\b", text):
        title = re.search(r"(?is)<title[^>]*>(.*?)</title>", text)
        return re.sub(r"\s+", " ", title.group(1)).strip() if title else ""
    try:
        data = json.loads(text)
    except ValueError:
        return text
    for node in (data.get("error"), data.get("detail"), data) if isinstance(data, dict) else ():
        if isinstance(node, str) and node.strip():
            return node.strip()
        if isinstance(node, dict) and isinstance(node.get("message"), str) and node["message"].strip():
            return node["message"].strip()
    return text


def upstream_detail(error: urllib.error.HTTPError, cap: int = 500) -> str:
    """Return an actionable provider failure including its response body."""
    body = ""
    try:
        body = _summarize_error_body(error.read().decode("utf-8", "replace")[:8192])
    except Exception:
        pass
    return f"upstream {error.code}: {body[:cap] or error.reason}"


def open_ai(
    messages, system, entry, runtime, pdf_b64s=None, effort="",
    max_tokens=8192, timeout=60, images=None, stream=False, tools=None,
):
    """Open a provider call without consuming response bytes."""
    conf = runtime["providers"][entry["provider"]]
    build_request = _WIRE[wire_protocol(runtime, entry, tools)][0]
    request = build_request(
        conf, messages, system, entry["model"], pdf_b64s,
        effort, max_tokens, images, stream, tools,
    )
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        detail = upstream_detail(error)
        log.warning(f"[ai] {detail}")
        raise UpstreamError(error.code, detail)


def read_reply(response, provider_protocol) -> str:
    """Read the full reply text from an open provider response."""
    if provider_protocol in ("chatgpt", "openai-responses"):
        return "".join(sse_deltas(response, provider_protocol))
    return _WIRE[provider_protocol][1](json.loads(response.read()))


def call_ai(
    messages, system, entry, runtime, pdf_b64s=None, effort="",
    max_tokens=8192, timeout=60, images=None,
):
    """Send a chat and return its complete reply text."""
    with open_ai(
        messages, system, entry, runtime, pdf_b64s,
        effort, max_tokens, timeout, images,
    ) as response:
        return read_reply(response, protocol(runtime, entry))


def sse_deltas(response, provider_protocol):
    """Yield text deltas from a provider's SSE response."""
    for kind, data in sse_events(response, provider_protocol):
        if kind == "text":
            yield data


def _parse_tool_args(raw) -> dict:
    try:
        parsed = json.loads(raw or "{}")
    except ValueError:
        parsed = None
    return parsed if isinstance(parsed, dict) else {}


def _partial_json_string(raw: str):
    """Decode the *unterminated* JSON string body ``raw`` (everything after
    its opening quote) as far as it goes: a trailing lone backslash or a
    half-written ``\\uXXXX`` is dropped rather than failing."""
    s = raw
    # Trim an incomplete escape at the very end (backslash run of odd length,
    # or \u with fewer than 4 hex digits after it).
    m = re.search(r'(\\+)$', s)
    if m and len(m.group(1)) % 2 == 1:
        s = s[:-1]
    m = re.search(r'(?<!\\)((?:\\\\)*)\\u([0-9a-fA-F]{0,3})$', s)
    if m:
        s = s[:m.start(2) - 2]
    try:
        return json.loads('"' + s + '"')
    except ValueError:
        return None


def _scan_json_string(s: str, i: int):
    """``s[i]`` is an opening quote: return ``(end_index_exclusive, complete)``
    — the index just past the closing quote, or ``len(s)`` when the string is
    still open."""
    j = i + 1
    n = len(s)
    while j < n:
        ch = s[j]
        if ch == "\\":
            j += 2
            continue
        if ch == '"':
            return j + 1, True
        j += 1
    return n, False


def partial_json_object(raw: str) -> dict:
    """Best-effort read of a JSON object that is still being streamed: every
    top-level key whose STRING value is complete, plus the one string value
    currently being written (decoded as far as it goes). Non-string values
    (numbers, lists, nested objects) are skipped — the tool argument the UI
    previews live (a block's markdown) is a string, and ids are strings.
    Never raises; ``{}`` when nothing is readable yet."""
    out = {}
    s = raw or ""
    i = s.find("{")
    if i < 0:
        return out
    i += 1
    n = len(s)
    while i < n:
        # key
        q = s.find('"', i)
        if q < 0:
            break
        end, complete = _scan_json_string(s, q)
        if not complete:
            break
        try:
            key = json.loads(s[q:end])
        except ValueError:
            break
        i = end
        while i < n and s[i] in " \t\r\n":
            i += 1
        if i >= n or s[i] != ":":
            break
        i += 1
        while i < n and s[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        if s[i] == '"':
            end, complete = _scan_json_string(s, i)
            if complete:
                try:
                    out[key] = json.loads(s[i:end])
                except ValueError:
                    break
                i = end
            else:
                value = _partial_json_string(s[i + 1:])
                if value is not None:
                    out[key] = value
                break
        else:
            # Skip a non-string value: scan to the next top-level comma or the
            # closing brace, honouring nesting and strings.
            depth = 0
            j = i
            while j < n:
                ch = s[j]
                if ch == '"':
                    j, complete = _scan_json_string(s, j)
                    if not complete:
                        return out
                    continue
                if ch in "[{":
                    depth += 1
                elif ch in "]}":
                    if depth == 0:
                        break
                    depth -= 1
                elif ch == "," and depth == 0:
                    break
                j += 1
            if j >= n:
                break
            i = j
        # after a value: "," → next key, "}" → done
        while i < n and s[i] in " \t\r\n":
            i += 1
        if i >= n or s[i] == "}":
            break
        if s[i] == ",":
            i += 1
    return out


def partial_json_strings(raw: str) -> list:
    """Best-effort read of a JSON array of strings still being streamed (the
    translation reply): the complete elements plus the one being written,
    decoded as far as it goes. Prose or a code fence before the ``[`` is
    skipped. Never raises; ``[]`` when nothing is readable yet."""
    out = []
    s = raw or ""
    i = s.find("[")
    if i < 0:
        return out
    i += 1
    n = len(s)
    while i < n:
        while i < n and s[i] in " \t\r\n,":
            i += 1
        if i >= n or s[i] == "]":
            break
        if s[i] != '"':
            # null or some other non-string element: stop previewing here.
            break
        end, complete = _scan_json_string(s, i)
        if complete:
            try:
                out.append(json.loads(s[i:end]))
            except ValueError:
                break
            i = end
        else:
            value = _partial_json_string(s[i + 1:])
            if value is not None:
                out.append(value)
            break
    return out


def sse_events(response, provider_protocol):
    """Yield ``("text", delta)``, ``("tool", {id, name, arguments})`` and
    ``("tool_delta", {id, name, json})`` events from a provider's SSE
    response. A ``tool_delta`` carries the tool call's arguments as streamed
    SO FAR (raw, possibly truncated JSON — see ``partial_json_object``) so a
    consumer can preview a long argument while the model is still writing
    it; the ``tool`` event with the parsed arguments always follows. Raises
    on a fully empty response (neither text nor tool calls) with the stop
    reason attached."""
    got = False
    stop = ""
    tool = None    # anthropic: {id, name, json} tool_use block being accumulated
    pending = {}   # openai: index -> {id, name, args} accumulated across deltas
    items = {}     # responses: item id -> {id (call_id), name, args} being streamed
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
            if kind == "content_block_start":
                block = event.get("content_block") or {}
                if block.get("type") == "tool_use":
                    tool = {"id": block.get("id") or "", "name": block.get("name") or "", "json": ""}
            elif kind == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "input_json_delta" and tool is not None:
                    tool["json"] += delta.get("partial_json") or ""
                    yield ("tool_delta", dict(tool))
                else:
                    text = delta.get("text") or ""
                    if text:
                        got = True
                        yield ("text", text)
            elif kind == "content_block_stop":
                if tool is not None:
                    got = True
                    yield ("tool", {"id": tool["id"], "name": tool["name"],
                                    "arguments": _parse_tool_args(tool["json"])})
                    tool = None
            elif kind == "message_delta":
                stop = (event.get("delta") or {}).get("stop_reason") or stop
            elif kind == "error":
                raise RuntimeError((event.get("error") or {}).get("message") or "stream error")
        elif provider_protocol in ("chatgpt", "openai-responses"):
            kind = event.get("type") or ""
            if kind == "response.output_text.delta":
                text = event.get("delta") or ""
                if text:
                    got = True
                    yield ("text", text)
            elif kind == "response.output_item.added":
                item = event.get("item") or {}
                if item.get("type") == "function_call":
                    items[item.get("id") or ""] = {
                        "id": item.get("call_id") or item.get("id") or "",
                        "name": item.get("name") or "", "json": ""}
            elif kind == "response.function_call_arguments.delta":
                slot = items.get(event.get("item_id") or "")
                if slot is not None:
                    slot["json"] += event.get("delta") or ""
                    yield ("tool_delta", dict(slot))
            elif kind == "response.output_item.done":
                item = event.get("item") or {}
                if item.get("type") == "function_call":
                    got = True
                    items.pop(item.get("id") or "", None)
                    yield ("tool", {"id": item.get("call_id") or item.get("id") or "",
                                    "name": item.get("name") or "",
                                    "arguments": _parse_tool_args(item.get("arguments"))})
            elif kind == "response.completed":
                stop = (event.get("response") or {}).get("status") or "completed"
            elif kind in ("response.failed", "error"):
                error = (
                    (event.get("response") or {}).get("error") or {}
                    if kind == "response.failed"
                    else event
                )
                raise RuntimeError(error.get("message") or "stream error")
        else:
            if event.get("error"):
                raise RuntimeError((event["error"] or {}).get("message") or "stream error")
            choice = (event.get("choices") or [{}])[0]
            delta = choice.get("delta") or {}
            text = delta.get("content") or ""
            if text:
                got = True
                yield ("text", text)
            for tc in delta.get("tool_calls") or []:
                slot = pending.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]
                    yield ("tool_delta", {"id": slot["id"], "name": slot["name"],
                                          "json": slot["args"]})
            stop = choice.get("finish_reason") or stop
    # OpenAI announces tool calls piecewise; emit them once the stream ends.
    for _, slot in sorted(pending.items()):
        got = True
        yield ("tool", {"id": slot["id"], "name": slot["name"],
                        "arguments": _parse_tool_args(slot["args"])})
    if not got:
        raise RuntimeError(
            f"empty response (stop reason={stop or 'unknown'} — a reasoning model may have spent "
            "the whole token budget thinking; try effort: low or a shorter request)"
        )
