from gamma import ai_context, pdf_text


def test_physical_page_labels_include_blank_pages_and_start_page(monkeypatch):
    pages = ["first", "", "third", "fourth"]
    monkeypatch.setattr(pdf_text, "iter_page_texts",
                        lambda src, start_page=1: iter(pages[start_page - 1:]))
    text, count = pdf_text.extract_text_pages("unused", 1000, label_pages=True)
    assert text == "[PDF page 1]\nfirst\n\n[PDF page 3]\nthird\n\n[PDF page 4]\nfourth"
    assert count == 4
    assert pdf_text.extract_text("unused", 1000, start_page=3, label_pages=True).startswith("[PDF page 3]")
    assert pdf_text.extract_text("unused", 1000) == "first\n\nthird\n\nfourth"


def test_continuation_repeats_page_label_without_changing_offsets(monkeypatch):
    monkeypatch.setattr(ai_context, "pdf_path", lambda *args: "unused")
    monkeypatch.setattr(pdf_text, "iter_page_texts",
                        lambda src, start_page=1: iter(["A" * 100, "B" * 100]))
    text, next_offset, _ = ai_context.pdf_excerpt("ws", "doc", 20, offset=45)
    assert text == "[PDF page 1; continued]\n" + "A" * 20
    assert next_offset == 65
    text, _, _ = ai_context.pdf_excerpt("ws", "doc", 20, offset=118)
    assert text.startswith("[PDF page 2; continued]\n")
    assert "PDF page 1" not in text


def test_selection_windows_label_each_physical_page():
    assert ai_context._join_upto(["first", "second", "third"], 1, 1000) == (
        "[PDF page 2]\nsecond\n\n[PDF page 3]\nthird")
