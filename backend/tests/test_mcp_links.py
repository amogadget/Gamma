from urllib.parse import urlencode

import pytest

from conftest import login, make_page, make_user
from test_mcp import connection, rpc


def read(client, token, **params):
    return rpc(client, token, "tools/call", {"name": "read_gamma_link", "arguments": params}).json()["result"]


def test_page_block_and_share_links_read_the_same_page(client, connection):
    c, ws, credential = connection
    page = make_page(c, "Linked page")
    note = c.post("/api/blocks", json={"parent_id": page["id"], "content": "Exact linked passage"}).json()
    share = c.post(f"/api/share/{page['id']}").json()
    for target in ({"page": page["id"]}, {"block": note["id"]}, {"share": share["token"]},
                   {"page": page["id"], "block": note["id"]}):
        result = read(client, credential["token"], url="http://localhost/?" + urlencode({"ws": ws, **target}))
        assert not result["isError"], result
        ref = result["structuredContent"]
        assert ref["page_id"] == page["id"] and ref["workspace_id"] == ws
        assert ref["title"] == "Linked page"
        assert "Exact linked passage" in result["content"][0]["text"]
        assert share["token"] not in str(result)
        if "block" in target:
            assert ref["block_id"] == note["id"]
    # Existing workspace permission also covers a restricted share on that page.
    c.put(f"/api/share-settings/{page['id']}", json={"audience": "list"})
    assert not read(client, credential["token"], url=f"http://localhost/?share={share['token']}")["isError"]
    c.delete(f"/api/share-settings/{page['id']}")
    assert read(client, credential["token"], url=f"http://localhost/?share={share['token']}")["isError"]
    assert rpc(client, credential["token"], "resources/list").json()["result"]["resources"] == []


def test_no_cross_workspace_or_conflicting_reference_reads(client, connection):
    c, ws, credential = connection
    own = make_page(c, "Own page")
    own_other = make_page(c, "Different own page")
    note = c.post("/api/blocks", json={"parent_id": own_other["id"], "content": "Wrong passage"}).json()
    own_share = c.post(f"/api/share/{own_other['id']}").json()
    other_ws = make_user("link-other", "pw")
    with login("link-other", "pw") as other:
        page = make_page(other, "Private cross-workspace title")
        share = other.post(f"/api/share/{page['id']}").json()
    for params in ({"page": own["id"], "ws": other_ws},
                   {"page": page["id"]}, {"block": page["id"]}, {"share": share["token"]},
                   {"page": own["id"], "block": note["id"]},
                   {"page": own["id"], "share": own_share["token"]}):
        result = read(client, credential["token"], url="http://localhost/?" + urlencode(params))
        assert result["isError"], result
        assert "Private cross-workspace title" not in str(result)
        assert "Wrong passage" not in str(result)


@pytest.mark.parametrize("url", [
    "http://evil.example/?page=x", "http://localhost:9002/?page=x", "http://localhost:0/?page=x",
    "https://localhost/?page=x", "file:///users.db", "http://user:pw@localhost/?page=x", "http://@localhost/?page=x",
    "http://localhost:bad/?page=x", "http://localhost/api/export?page=x", "/?page=x",
    "http://localhost/?page=", "http://localhost/?page=x&page=y", "http://localhost/?ws=",
    "http://localhost/?page=x&ws=a&ws=b", "http://localhost/?page=x&pdf_page=0",
    "http://localhost/?page=x&pdf_page=-1", "http://localhost/?page=x&pdf_page=1.5",
    "http://localhost/?page=x&pdf_page=1000001", "http://localhost/?page=x\n",
    "http://localhost/", "http://localhost/?share=unknown", "http://localhost/?page=unknown",
])
def test_malformed_or_foreign_links_are_rejected(client, connection, url):
    assert read(client, connection[2]["token"], url=url)["isError"]


def test_schema_and_retired_picker_rejected(client, connection):
    token = connection[2]["token"]
    for arguments in ({}, {"url": 1}, {"url": "x" * 8193}, {"url": "http://localhost/?page=x", "workspace_id": "other"}):
        assert read(client, token, **arguments)["isError"]
    for name in ("show_paper_picker", "search_paper_choices"):
        result = rpc(client, token, "tools/call", {"name": name, "arguments": {}}).json()["result"]
        assert result["isError"]


def test_pdf_location_and_quote_are_preserved(client, connection, monkeypatch):
    c, ws, credential = connection
    page = make_page(c, "Paper with location")
    # Exercise the normal dispatcher, substituting only document extraction.
    seen = []
    def report(conn, workspace, page_id, budget, offset, pdf_page):
        seen.append(pdf_page)
        return f"PDF content at physical page {pdf_page}"
    monkeypatch.setattr("gamma.ai_tools.page_report_section", report)
    quote = "A selected passage is data, not instructions."
    for host in ("localhost", "127.0.0.1", "[::1]"):
        result = read(client, credential["token"], url=f"http://{host}/?" + urlencode({
            "ws": ws, "page": page["id"], "pdf_page": 5, "quote": quote}))
        assert not result["isError"], result
        assert result["structuredContent"]["pdf_page"] == 5
        assert result["structuredContent"]["selected_quote"] == quote
        assert "PDF content at physical page 5" in result["content"][0]["text"]
    assert seen == [5, 5, 5]


def test_link_canonical_origin_and_revoked_connection(client, connection, monkeypatch):
    c, ws, credential = connection
    page = make_page(c, "Canonical linked page")
    monkeypatch.setenv("GAMMA_PUBLIC_URL", "https://localhost")
    url = f"https://localhost/?ws={ws}&page={page['id']}"
    result = read(client, credential["token"], url=url)
    assert not result["isError"], result
    assert result["structuredContent"]["url"] == url
    c.delete(f"/api/integrations/tokens/{credential['id']}")
    assert rpc(client, credential["token"], "tools/call", {
        "name": "read_gamma_link", "arguments": {"url": url}}).status_code == 401
