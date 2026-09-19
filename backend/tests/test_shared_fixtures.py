"""Rules the frontend mirrors, pinned by one set of cases both sides read:
tests/shared/*.json at the repository root. The node half is
frontend/tests/textnorm.test.mjs and libraryUtils.test.mjs; a case added
here fails whichever side drifts."""

import json
from pathlib import Path

import pytest

from gamma import foldertags
from gamma.textnorm import fuzzy_pattern, normalize_text

SHARED = Path(__file__).resolve().parents[2] / "tests" / "shared"


def _load(name):
    return json.loads((SHARED / name).read_text(encoding="utf-8"))


TEXTNORM = _load("textnorm.json")
FOLDERTAGS = _load("foldertags.json")


@pytest.mark.parametrize("case", TEXTNORM["normalize"], ids=[c["note"] for c in TEXTNORM["normalize"]])
def test_normalize_text(case):
    assert normalize_text(case["input"]) == case["output"]


@pytest.mark.parametrize("case", TEXTNORM["fuzzy"], ids=[c["note"] for c in TEXTNORM["fuzzy"]])
def test_fuzzy_pattern(case):
    pat = fuzzy_pattern(case["query"], case=case.get("case", False), whole=case.get("whole", False))
    if "pattern" in case and case["pattern"] is None:
        assert pat is None
        return
    assert pat is not None
    assert bool(pat.search(case["text"])) is case["match"], pat.pattern


def test_folder_tag_rules():
    for case in FOLDERTAGS["parse_tags"]:
        assert foldertags.parse_tags(case["input"]) == case["output"], case
    for case in FOLDERTAGS["clean_segment"]:
        assert foldertags.clean_segment(case["input"]) == case["output"], case
    for case in FOLDERTAGS["clean_path"]:
        assert foldertags.clean_path(case["input"]) == case["output"], case
    for case in FOLDERTAGS["add_tag"]:
        assert foldertags.add_tag(list(case["tags"]), case["path"]) == case["output"], case
