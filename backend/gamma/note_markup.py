"""Note source (markdown + LaTeX) → drawable items for the on-page note boxes.

Notes are markdown with ``$…$`` / ``$$…$$`` math (the editor renders them with
KaTeX) and ``![](/api/uploads/…)`` image refs. Drawing the raw source into the
PDF box would show ``$\\frac{1}{2}$`` and a naked URL, so this module turns a
note into the small item list ``pdf_notes`` lays out:

    {"kind": "text",  "spans": [(text, level), …]}   level 0 / +1 sup / -1 sub
    {"kind": "image", "src": "/api/uploads/ab12.png", "alt": "…"}

Math is *approximated*, not typeset — there is no TeX engine on the server.
Commands become their unicode symbol (drawn with the base-14 Symbol font, which
every PDF viewer has), ``^``/``_`` become genuinely raised/lowered runs, and
structures collapse to inline forms (``\\frac{a}{b}`` → ``a/b``, ``\\sqrt x`` →
``√x``). Unknown commands fall back to their own name, which is what you want
for ``\\sin``, ``\\log``, ``\\max`` and friends.
"""

import re

SUP, SUB = 1, -1

# LaTeX command → unicode. Every value here is either WinAnsi- or Symbol-font
# encodable (see pdf_notes._font_of), so it can actually be drawn.
SYMBOLS = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ",
    "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
    "pi": "π", "varpi": "ϖ", "rho": "ρ", "sigma": "σ", "varsigma": "ς",
    "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "ϕ", "chi": "χ",
    "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "∆", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
    "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ",
    "Omega": "Ω",
    "sum": "∑", "prod": "∏", "int": "∫", "infty": "∞", "partial": "∂",
    "nabla": "∇", "surd": "√", "pm": "±", "times": "×", "div": "÷",
    "cdot": "⋅", "bullet": "•", "ast": "∗", "star": "∗", "circ": "°",
    "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
    "approx": "≈", "equiv": "≡", "cong": "≅", "sim": "∼", "simeq": "≅",
    "propto": "∝", "perp": "⊥", "angle": "∠", "degree": "°", "prime": "′",
    "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆",
    "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩", "emptyset": "∅",
    "varnothing": "∅", "forall": "∀", "exists": "∃", "neg": "¬", "lnot": "¬",
    "land": "∧", "wedge": "∧", "lor": "∨", "vee": "∨", "therefore": "∴",
    "oplus": "⊕", "otimes": "⊗", "aleph": "ℵ",
    "to": "→", "rightarrow": "→", "gets": "←", "leftarrow": "←",
    "uparrow": "↑", "downarrow": "↓", "leftrightarrow": "↔",
    "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔", "iff": "⇔",
    "implies": "⇒", "mapsto": "→",
    "ldots": "…", "cdots": "…", "dots": "…", "vdots": "…", "hbar": "h",
    "Re": "ℜ", "Im": "ℑ", "wp": "℘", "langle": "〈", "rangle": "〉",
    "lvert": "|", "rvert": "|", "vert": "|", "mid": "|", "|": "|",
    "{": "{", "}": "}", "$": "$", "%": "%", "&": "&", "#": "#", "_": "_",
}

# Commands that only affect spacing/size — dropped, or reduced to one space.
_SPACERS = {"left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr",
            "Bigl", "Bigr", "displaystyle", "textstyle", "scriptstyle",
            "limits", "nolimits", "!", "@"}
_THIN = {",", ";", ":", " ", "quad", "qquad", "enspace", "thinspace", "hspace"}
# Contents kept, styling dropped.
_TRANSPARENT = {"text", "textrm", "textbf", "textit", "mathrm", "mathbf",
                "mathit", "mathsf", "mathtt", "mathcal", "mathbb", "mathfrak",
                "boldsymbol", "operatorname", "mbox", "hbox", "bm", "pmb",
                "overline", "underline", "tilde", "hat", "bar", "vec", "dot"}

_IMG_RE = re.compile(r"!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)")
_MATH_RE = re.compile(
    r"\$\$(.+?)\$\$"          # display $$ … $$
    r"|\\\[(.+?)\\\]"         # display \[ … \]
    r"|\$([^$\n]+?)\$"        # inline $ … $
    r"|\\\((.+?)\\\)",        # inline \( … \)
    re.S,
)


def _read_group(tex: str, i: int):
    """The argument starting at ``i``: a {...} group, a \\command, or one char."""
    n = len(tex)
    while i < n and tex[i] == " ":
        i += 1
    if i >= n:
        return "", i
    if tex[i] == "{":
        depth, start = 1, i + 1
        j = start
        while j < n and depth:
            if tex[j] == "\\":
                j += 2
                continue
            depth += 1 if tex[j] == "{" else -1 if tex[j] == "}" else 0
            j += 1
        return tex[start:j - 1], j
    if tex[i] == "\\":
        j = i + 1
        while j < n and tex[j].isalpha():
            j += 1
        return tex[i:max(j, i + 2)], max(j, i + 2)
    return tex[i], i + 1


def _atomic(spans) -> bool:
    """True when the spans read as one symbol — no parentheses needed."""
    text = "".join(t for t, _ in spans)
    return len(text) <= 1 or (text.isalnum() and len(text) <= 2)


def _paren(spans, level):
    return spans if _atomic(spans) else [("(", level)] + spans + [(")", level)]


def latex_spans(tex: str, level: int = 0):
    """LaTeX fragment → [(text, level)]. Newlines survive as "\\n" spans."""
    out, i, n = [], 0, len(tex)
    while i < n:
        ch = tex[i]
        if ch == "\\":
            j = i + 1
            while j < n and tex[j].isalpha():
                j += 1
            cmd = tex[i + 1:j] if j > i + 1 else tex[i + 1:i + 2]
            i = j if j > i + 1 else i + 2
            if cmd == "\\":
                out.append(("\n", level))
            elif cmd in SYMBOLS:
                out.append((SYMBOLS[cmd], level))
            elif cmd in _SPACERS:
                pass
            elif cmd in _THIN:
                out.append((" ", level))
            elif cmd in _TRANSPARENT:
                g, i = _read_group(tex, i)
                out.extend(latex_spans(g, level))
            elif cmd in ("frac", "dfrac", "tfrac", "binom"):
                a, i = _read_group(tex, i)
                b, i = _read_group(tex, i)
                out.extend(_paren(latex_spans(a, level), level))
                out.append(("/", level))
                out.extend(_paren(latex_spans(b, level), level))
            elif cmd == "sqrt":
                if i < n and tex[i] == "[":          # \sqrt[n]{…} — index dropped
                    i = tex.find("]", i) + 1 or i
                g, i = _read_group(tex, i)
                out.append(("√", level))
                out.extend(_paren(latex_spans(g, level), level))
            elif cmd in ("ket", "bra", "braket", "ketbra"):
                a, i = _read_group(tex, i)
                if cmd == "ket":
                    out += [("|", level)] + latex_spans(a, level) + [("〉", level)]
                elif cmd == "bra":
                    out += [("〈", level)] + latex_spans(a, level) + [("|", level)]
                else:
                    b, i = _read_group(tex, i)
                    out += ([("〈", level)] + latex_spans(a, level) + [("|", level)]
                            + latex_spans(b, level) + [("〉", level)])
            elif cmd in ("begin", "end"):
                _, i = _read_group(tex, i)           # environment name
                out.append(("\n", level))
            elif cmd == "over":
                out.append(("/", level))
            else:
                out.append((cmd, level))             # \sin, \log, \max …
        elif ch in "^_":
            g, i = _read_group(tex, i + 1)
            out.extend(latex_spans(g, SUP if ch == "^" else SUB))
        elif ch in "{}":
            i += 1
        elif ch in "&~":
            out.append((" ", level))
            i += 1
        elif ch == "%":
            i = tex.find("\n", i)
            if i < 0:
                break
        else:
            out.append((ch, level))
            i += 1
    return merge_spans(out)


def _plain(md: str) -> str:
    """Markdown → the text a reader sees (emphasis markers, code ticks and
    link targets stripped; images are pulled out before this runs)."""
    md = re.sub(r"^\s{0,3}#{1,6}\s+", "", md)
    md = re.sub(r"^\s*>\s?", "", md)
    md = _LINK_RE.sub(r"\1", md)
    md = re.sub(r"\*\*(.+?)\*\*|__(.+?)__", lambda m: m.group(1) or m.group(2), md)
    md = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", md)
    md = re.sub(r"`+([^`]*)`+", r"\1", md)
    return md


def merge_spans(spans):
    """Collapse neighbouring spans that share a level."""
    out = []
    for text, level in spans:
        if out and out[-1][1] == level:
            out[-1] = (out[-1][0] + text, level)
        elif text:
            out.append((text, level))
    return [(t, lv) for t, lv in out if t]


def parse_note(text: str):
    """Note source → [item]; see the module docstring for the item shapes."""
    items, line = [], []

    def flush():
        if line:
            spans = merge_spans(line)
            if any(t.strip() for t, _ in spans):
                items.append({"kind": "text", "spans": spans})
            line.clear()

    def add_spans(spans):
        for text_, level in spans:
            for k, part in enumerate(text_.split("\n")):
                if k:
                    flush()
                if part:
                    line.append((part, level))

    def add_plain(chunk: str):
        for k, raw in enumerate(chunk.split("\n")):
            if k:
                flush()
            pos = 0
            for m in _IMG_RE.finditer(raw):
                add_spans([(_plain(raw[pos:m.start()]), 0)])
                flush()
                items.append({"kind": "image", "src": m.group(2), "alt": m.group(1)})
                pos = m.end()
            add_spans([(_plain(raw[pos:]), 0)])

    pos = 0
    for m in _MATH_RE.finditer(text):
        add_plain(text[pos:m.start()])
        display = bool(m.group(1) or m.group(2))
        tex = m.group(1) or m.group(2) or m.group(3) or m.group(4) or ""
        if display:
            flush()
        add_spans(latex_spans(tex.strip()))
        if display:
            flush()
        pos = m.end()
    add_plain(text[pos:])
    flush()
    return items
