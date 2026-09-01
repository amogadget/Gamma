"""Model selectors present the newest generation first.

Providers list dozens of models; ordering puts the one people reach for at the
top. Nothing is filtered out — a cheap older model is the right choice for bulk
jobs (translation, metadata), so hiding by "generation" would remove exactly
those. The ranking is deliberately generic rather than a per-vendor table,
since vendors rename things constantly; these tests pin the cases that made the
naive version wrong.
"""

from gamma.ai_settings import _model_rank, sort_models_newest_first


def test_openai_generations_descend():
    assert sort_models_newest_first(
        ["gpt-4o", "gpt-5.1", "gpt-5.6", "gpt-3.5-turbo"]
    ) == ["gpt-5.6", "gpt-5.1", "gpt-4o", "gpt-3.5-turbo"]


def test_minor_version_beats_major_only():
    # 5.6 > 5.1 > 5 — a bare major must not outrank its own point releases.
    assert sort_models_newest_first(["gpt-5.1", "gpt-5", "gpt-5.6"]) \
        == ["gpt-5.6", "gpt-5.1", "gpt-5"]


def test_anthropic_family_generations_and_dates():
    ordered = sort_models_newest_first([
        "claude-3-opus-20240229",
        "claude-haiku-4-5-20251001",
        "claude-3-5-sonnet-20240620",
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-1-20250805",
    ])
    assert ordered == [
        "claude-haiku-4-5-20251001",   # gen 4.5, newest date
        "claude-sonnet-4-5-20250929",  # gen 4.5
        "claude-opus-4-1-20250805",    # gen 4.1
        "claude-3-5-sonnet-20240620",  # gen 3.5
        "claude-3-opus-20240229",      # gen 3
    ]


def test_cheap_models_are_kept_not_filtered():
    """The whole point of sorting instead of filtering: haiku/mini survive."""
    names = ["claude-opus-4-5", "claude-haiku-4-5", "gpt-5.6", "gpt-4o-mini"]
    assert set(sort_models_newest_first(names)) == set(names)


def test_latest_alias_orders_within_its_family_only():
    # "latest" marks the newest build of a family; it must not lift a 4o model
    # above a 5.x one.
    ordered = sort_models_newest_first(["chatgpt-4o-latest", "gpt-4o", "gpt-5.6"])
    assert ordered[0] == "gpt-5.6"
    assert ordered.index("chatgpt-4o-latest") < ordered.index("gpt-4o")


def test_parameter_counts_are_not_versions():
    """llama-3.3-70b must not outrank gpt-5.6 — 70 is a parameter count."""
    ordered = sort_models_newest_first(["llama-3.3-70b", "gpt-5.6"])
    assert ordered == ["gpt-5.6", "llama-3.3-70b"]
    assert _model_rank("llama-3.3-70b")[0] == 3


def test_context_windows_and_moe_shapes_are_not_versions():
    assert _model_rank("gpt-4o-32k")[0] == 4        # not 32
    assert _model_rank("mixtral-8x7b")[0] == 0      # 8x7b is a shape, not a gen
    assert _model_rank("qwen2.5-72b-instruct")[0] == 2


def test_build_ids_do_not_become_generations():
    # A bare 4-digit build id is not a version, and is capped out anyway.
    assert _model_rank("mistral-large-2411")[0] <= 20


def test_unversioned_names_sort_last_but_survive():
    ordered = sort_models_newest_first(["deepseek-chat", "gpt-5.6", "deepseek-reasoner"])
    assert ordered[0] == "gpt-5.6"
    assert set(ordered[1:]) == {"deepseek-chat", "deepseek-reasoner"}


def test_ties_keep_provider_order_so_sorting_is_stable():
    names = ["alpha-model", "beta-model", "gamma-model"]
    assert sort_models_newest_first(names) == names


def test_degenerate_input():
    assert sort_models_newest_first([]) == []
    assert sort_models_newest_first([""]) == [""]
    assert _model_rank(None)[0] == 0


def test_runtime_orders_models_but_keeps_the_default(guest, monkeypatch):
    """rt["default"] must stay the first PINNED model even though the list is
    presented newest-first: it is the fallback for a request that names no
    model, and promoting the newest would raise the cost of bulk jobs."""
    from gamma import ai_settings

    entry = {
        "id": "p1", "protocol": "anthropic", "api_key": "sk-ant-order-1",
        "name": "Test", "models": "claude-3-opus-20240229, claude-haiku-4-5-20251001",
    }
    monkeypatch.setattr(ai_settings, "load_provider_entries", lambda user: [entry])
    rt = ai_settings.ai_runtime("guest")

    assert [m["model"] for m in rt["models"]] == [
        "claude-haiku-4-5-20251001",   # newest first for display
        "claude-3-opus-20240229",
    ]
    # …but the default is still what the user pinned first.
    assert rt["default"]["model"] == "claude-3-opus-20240229"


def test_pinned_models_stay_ahead_of_a_newer_catalog(guest, monkeypatch):
    """Curated-before-catalog is a documented guarantee, so newest-first sorts
    WITHIN each group: a pinned old model keeps its place at the top, and the
    fetched catalog is ordered newest-first behind it."""
    from gamma import ai_settings

    entry = {
        "id": "p1", "protocol": "anthropic", "api_key": "sk-ant-order-2",
        "name": "Test", "models": "claude-3-opus-20240229",
        "catalog_models": ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"],
    }
    monkeypatch.setattr(ai_settings, "load_provider_entries", lambda user: [entry])
    rt = ai_settings.ai_runtime("guest")

    assert [m["model"] for m in rt["models"]] == [
        "claude-3-opus-20240229",       # pinned, stays first
        "claude-haiku-4-5-20251001",    # catalog, newest date first
        "claude-sonnet-4-5-20250929",
    ]
    assert rt["default"]["model"] == "claude-3-opus-20240229"
    # every model still offered, none filtered away
    assert len(rt["models"]) == 3
