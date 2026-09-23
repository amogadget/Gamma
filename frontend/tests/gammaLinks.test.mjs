import test from "node:test";
import assert from "node:assert/strict";
import { gammaLinkIds, parseGammaLink, relativeGammaLink } from "../src/shared/model/gammaLinks.js";

const ORIGIN = "https://gamma.test";

test("classifies block, page and citation links, relative or absolute", () => {
  const quote = "A result (n=42) & its evidence";
  assert.deepEqual(parseGammaLink(`/?page=paper&pdf_page=7&quote=${encodeURIComponent(quote)}`, ORIGIN),
    { kind: "citation", pageId: "paper", page: 7, quote, foreign: false });
  assert.deepEqual(parseGammaLink("?block=blk_1", ORIGIN), { kind: "block", blockId: "blk_1", foreign: false });
  assert.deepEqual(parseGammaLink(`${ORIGIN}/?page=paper&ws=w1`, ORIGIN),
    { kind: "page", pageId: "paper", foreign: false });
  // A quote is optional: the link then just opens the paper at that page.
  assert.deepEqual(parseGammaLink("/?page=paper&pdf_page=2", ORIGIN),
    { kind: "citation", pageId: "paper", page: 2, quote: "", foreign: false });
});

test("a link written against another host stays a Gamma link, marked foreign", () => {
  // The server moved (sidecar → NAS), or this is somebody else's Gamma: the
  // caller decides by resolving the id, so the shape must still parse.
  assert.deepEqual(parseGammaLink("https://old.host:9001/?page=paper&pdf_page=3&quote=long%20enough", ORIGIN),
    { kind: "citation", pageId: "paper", page: 3, quote: "long enough", foreign: true });
});

test("rejects non-Gamma URLs and malformed page/quote values", () => {
  for (const href of [
    "https://arxiv.org/abs/2401.00001",
    "/api/uploads/abc.pdf",
    "/?page=paper&pdf_page=-1",
    "/?page=paper&pdf_page=1.5",
    "/?page=paper&pdf_page=9999999",
    "/?page=bad%20id",
    "/?page=paper&pdf_page=1&quote=tiny",
    `/?page=paper&pdf_page=1&quote=${"x".repeat(2001)}`,
    "/?ws=w1",
  ]) assert.equal(parseGammaLink(href, ORIGIN), null, href);
});

test("collects the ids a note's markdown links to, from targets and bare URLs", () => {
  const text = "see [p. 3](/?page=paper&pdf_page=3&quote=long%20enough%20text), "
    + "[notes](?block=blk_2) and https://old.host/?page=other plus https://example.com/?page=x";
  assert.deepEqual(gammaLinkIds(text), ["paper", "blk_2", "other", "x"]);
  assert.deepEqual(gammaLinkIds("no links here"), []);
});

test("pasted links are stored host-free and workspace-free", () => {
  assert.equal(relativeGammaLink("https://old.host/?page=paper&ws=w1&pdf_page=2", ORIGIN), "/?page=paper&pdf_page=2");
  assert.equal(relativeGammaLink("?block=blk_1", ORIGIN), "/?block=blk_1");
});
