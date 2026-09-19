"""Zotero library import: a zip of the "Zotero RDF" export becomes pages with
metadata, collections→folder labels, tags→flat labels, notes→child blocks, and
the annotations embedded in the exported PDFs become highlight blocks."""

import io
import zipfile


def _annotated_pdf(text=b"Attention is all you need, says the paper."):
    """Minimal one-page PDF with a text layer and one /Highlight annotation
    (same hand-built construction as test_pdf_proxy's _text_pdf)."""
    stream = b"BT /F1 12 Tf 72 720 Td (" + text + b") Tj ET"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Annot /Subtype /Highlight /Rect [70 700 300 735]"
        b" /QuadPoints [70 735 300 735 70 700 300 700]"
        b" /C [1 0.85 0.3] /CA 0.5 /Contents (great point) >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n%s\nendobj\n" % (i, obj))
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
              % (len(objs) + 1, xref))
    return out.getvalue()


RDF = """<rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:z="http://www.zotero.org/namespaces/export#"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:bib="http://purl.org/net/biblio#"
 xmlns:foaf="http://xmlns.com/foaf/0.1/"
 xmlns:link="http://purl.org/rss/1.0/modules/link/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/">
    <bib:Article rdf:about="https://www.nature.com/articles/s41586-000-00000-0">
        <z:itemType>journalArticle</z:itemType>
        <dcterms:isPartOf rdf:resource="urn:issn:0028-0836"/>
        <bib:authors><rdf:Seq><rdf:li><foaf:Person>
            <foaf:surname>Vaswani</foaf:surname><foaf:givenName>Ashish</foaf:givenName>
        </foaf:Person></rdf:li></rdf:Seq></bib:authors>
        <link:link rdf:resource="#item_3"/>
        <dcterms:isReferencedBy rdf:resource="#item_9"/>
        <dc:title>Attention is all you need</dc:title>
        <dc:date>2017-06-12</dc:date>
        <dc:subject>transformers</dc:subject>
        <dc:subject><z:AutomaticTag><rdf:value>attention</rdf:value></z:AutomaticTag></dc:subject>
        <bib:pages>1-11</bib:pages>
    </bib:Article>
    <bib:Journal rdf:about="urn:issn:0028-0836">
        <dc:identifier>DOI 10.1038/s41586-000-00000-0</dc:identifier>
        <prism:volume>647</prism:volume>
        <dc:title>Nature</dc:title>
        <dc:identifier>ISSN 0028-0836</dc:identifier>
    </bib:Journal>
    <z:Attachment rdf:about="#item_3">
        <z:itemType>attachment</z:itemType>
        <z:path rdf:resource="files/3/Vaswani - 2017 - Attention.pdf"/>
        <dc:title>PDF</dc:title>
        <link:type>application/pdf</link:type>
    </z:Attachment>
    <bib:Memo rdf:about="#item_9">
        <rdf:value>&lt;p&gt;Read this &lt;strong&gt;twice&lt;/strong&gt;.&lt;/p&gt;</rdf:value>
    </bib:Memo>
    <rdf:Description rdf:about="https://arxiv.org/abs/1707.06347">
        <z:itemType>preprint</z:itemType>
        <dc:title>Proximal Policy Optimization</dc:title>
        <dc:date>2017</dc:date>
        <dc:identifier><dcterms:URI><rdf:value>https://arxiv.org/abs/1707.06347</rdf:value></dcterms:URI></dc:identifier>
    </rdf:Description>
    <z:Collection rdf:about="#collection_1">
        <dc:title>ML</dc:title>
        <dcterms:hasPart rdf:resource="#collection_2"/>
    </z:Collection>
    <z:Collection rdf:about="#collection_2">
        <dc:title>Transformers</dc:title>
        <dcterms:hasPart rdf:resource="https://www.nature.com/articles/s41586-000-00000-0"/>
    </z:Collection>
</rdf:RDF>
"""


def _export_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("zotero_export/zotero_export.rdf", RDF)
        zf.writestr("zotero_export/files/3/Vaswani - 2017 - Attention.pdf", _annotated_pdf())
    buf.seek(0)
    return buf


def _post(guest, **form):
    return guest.post("/api/import/zotero",
                      files={"file": ("lib.zip", _export_zip(), "application/zip")},
                      data=form)


def test_zotero_import_full(guest):
    r = _post(guest)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["items"] == 2
    assert d["pages_created"] == 2 and d["pages_merged"] == 0
    assert d["pdfs_stored"] == 1
    assert d["notes_imported"] == 1
    assert d["annotations_imported"] == 1
    assert d["skipped"] == []

    by_title = {p["title"]: p for p in d["pages"]}
    paper = by_title["Attention is all you need"]

    block = guest.get(f"/api/blocks/{paper['id']}").json()
    props = block["properties"]
    assert props["doc_id"] and props["source_url"].startswith("/api/uploads/")
    assert props["zotero_key"] == "https://www.nature.com/articles/s41586-000-00000-0"
    # nested collection → folder path; tags (incl. AutomaticTag) → flat labels
    assert props["folder"] == "ML/Transformers"
    assert props["category"] == "transformers, attention"
    meta = props["meta"]
    assert meta["source"] == "zotero" and meta["year"] == "2017"
    assert meta["authors"] == ["Ashish Vaswani"]
    # the DOI lives on the referenced journal record, the venue is its title
    assert meta["doi"] == "10.1038/s41586-000-00000-0"
    assert meta["venue"] == "Nature" and meta["volume"] == "647"
    assert "Vaswani" in props["bibtex"]

    children = guest.get(f"/api/blocks/{paper['id']}/children").json()["children"]
    notes = [c for c in children if c["properties"].get("zotero_note")]
    assert len(notes) == 1 and notes[0]["content"] == "Read this **twice**."
    annots = [c for c in children if c["properties"].get("imported_annot")]
    assert len(annots) == 1
    hl = annots[0]
    assert hl["content"] == "great point"  # the /Contents comment
    assert "Attention" in hl["properties"]["quote"]
    assert hl["properties"]["pdf_position"]["pageNumber"] == 1

    # the arXiv preprint has no PDF: metadata-only page, id from the URL
    pre = guest.get(f"/api/blocks/{by_title['Proximal Policy Optimization']['id']}").json()
    assert pre["properties"]["meta"]["arxiv_id"] == "1707.06347"
    assert "doc_id" not in pre["properties"]


def test_zotero_import_idempotent(guest):
    first = _post(guest).json()
    again = _post(guest)
    assert again.status_code == 200, again.text
    d = again.json()
    assert d["pages_created"] == 0
    assert d["pages_merged"] == 2
    assert d["notes_imported"] == 0
    assert d["annotations_imported"] == 0
    # same page ids as before — matched by doc_id / zotero_key, not duplicated
    assert {p["id"] for p in d["pages"]} == {p["id"] for p in first["pages"]}


def test_zotero_import_folder_prefix(guest):
    r = _post(guest, folder="zotero")
    assert r.status_code == 200, r.text
    d = r.json()
    by_title = {p["title"]: p for p in d["pages"]}
    paper = guest.get(f"/api/blocks/{by_title['Attention is all you need']['id']}").json()
    assert "zotero/ML/Transformers" in paper["properties"]["folder"]
    # an item in no collection lands at the prefix root
    pre = guest.get(f"/api/blocks/{by_title['Proximal Policy Optimization']['id']}").json()
    assert "zotero" in [t.strip() for t in pre["properties"]["folder"].split(",")]


def test_zotero_import_rejects_junk(guest):
    r = guest.post("/api/import/zotero",
                   files={"file": ("x.zip", io.BytesIO(b"not a zip"), "application/zip")})
    assert r.status_code == 400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "hi")
    buf.seek(0)
    r = guest.post("/api/import/zotero",
                   files={"file": ("x.zip", buf, "application/zip")})
    assert r.status_code == 400 and ".rdf" in r.json()["detail"]
