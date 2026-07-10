"""Search text normalization and fuzzy matching, shared by the PDF FTS index
(routers/search.py) and block search (routers/blocks.py).

The frontend mirrors these rules in search.jsx / pdfViewer.jsx so a query
matches the same way in the notes DB, the FTS index, and the live pdf.js
viewer — keep the three in sync when changing them.
"""

import re
import unicodedata

# One bump forces every user's PDF index to be rebuilt lazily (extraction or
# normalization changes make old rows stale).
INDEX_VERSION = 2

_DASHES = "‐‑‒–—―"
# Thousands separators PDFs use inside numbers: comma, nbsp, narrow nbsp, thin space
_DIGIT_SEPS = ",   "

_HYPHEN_BREAK_RE = re.compile(rf"(?<=\w)[-{_DASHES}]\s*\n\s*(?=\w)")
_DIGIT_SEP_RE = re.compile(rf"(?<=\d)[{_DIGIT_SEPS}](?=\d)")
_WS_RE = re.compile(r"\s+")


def normalize_text(s: str) -> str:
    """Canonical searchable form of extracted PDF text (and of queries):
    NFKC (folds ligatures like ﬁ), soft hyphens dropped, words re-joined
    across hyphenated line breaks, digit-group separators removed
    ("3,000" → "3000"), whitespace collapsed. Case is left alone — FTS5's
    tokenizer and regex flags handle that."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("­", "")
    s = _HYPHEN_BREAK_RE.sub("", s)
    s = _DIGIT_SEP_RE.sub("", s)
    return _WS_RE.sub(" ", s).strip()


def fuzzy_pattern(q: str, case: bool = False, whole: bool = False,
                  regex: bool = False) -> re.Pattern | None:
    """Compile a search query into a regex (None = invalid/empty).

    regex=True compiles the query as-is (VSCode-style). Otherwise the match is
    separator-tolerant: digits may be split by grouping separators ("3000"
    finds "3,000"), and spaces/hyphens are interchangeable ("3000 qubit" finds
    "3,000-qubit")."""
    flags = 0 if case else re.IGNORECASE
    if regex:
        body = q
    else:
        q = normalize_text(q)
        parts = []
        i = 0
        while i < len(q):
            c = q[i]
            if c.isspace() or c == "-" or c in _DASHES:
                parts.append(rf"[\s\-{_DASHES}]+")
                while i + 1 < len(q) and (q[i + 1].isspace() or q[i + 1] == "-" or q[i + 1] in _DASHES):
                    i += 1
            else:
                parts.append(re.escape(c))
                if c.isdigit() and i + 1 < len(q) and q[i + 1].isdigit():
                    parts.append(rf"[{_DIGIT_SEPS}\s]?")
            i += 1
        if not parts:
            return None
        body = "".join(parts)
    if whole:
        body = rf"\b(?:{body})\b"
    try:
        return re.compile(body, flags)
    except re.error:
        return None
