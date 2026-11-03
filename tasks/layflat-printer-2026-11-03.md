# Layflat premium book: printer research (2026-11-03)

Owner 2026-11-03: research a layflat printer (Gelato has glued binding only: catalog API, hard-cover-photobooks
BindingType = glued-left, checked 2026-11-03). Web research by agent, USD 0, all pages seen 2026-11-03.

## Verdict
- **Prodigi (owns Peecho)**: the only one with layflat hardcover + a self-serve order API (REST v4, sandbox, quote
  endpoint) + EU production + white-label parcels. SKU family BOOK-FE (e.g. BOOK-FE-A4-L-LF-G). Sizes 210x210, 297x297,
  A4 landscape, A4 portrait 210x297: **neither of our formats (21x28, 20x20)**. 18-122 pages (launch blog says 24), even
  counts. 190 gsm E-Photo Lustre. Price: only "From £17.51" wholesale excl. tax/shipping; real price needs the quote API.
  Swiss duties (DDP/DAP) not confirmed. Sources: prodigi.com/products/books-and-magazines/layflat-photo-book/,
  prodigi.com/print-api/docs/reference, prodigi.com/blog/photo-books-technical-guide/.
- TJ Books (UK): layflat personalised children's books, single copies, white-label, "API support" but contact-only, UK customs.
- Saal Digital: layflat on all books, no public API (B2B only). CEWE, ifolor, Mimeo, Mixam: layflat, no API found.
- No layflat via API: Cloudprinter, Lulu, Blurb/RPI (US/CA only), Printful/Printify, myposter (photobooks excluded).

## Open (owner)
- [ ] Prodigi: free account + sandbox key → quote layflat 210x210 and A4 portrait to CH; ask support about DDP/DAP to CH,
  which EU lab, minimum pages. Then one live sample order to CH (first sample 50% refunded).
- [ ] Our side: our pages would need re-layout for 210x297 / 210x210 (not 210x280 / 200x200).

## Prices (second research pass, 2026-11-03, USD 0)
No published WHOLESALE layflat price anywhere: Prodigi/Peecho show only "From £17.51" (excl. tax and shipping, size and
page count unstated) or a calculator. Real wholesale needs the Prodigi quote API.

Swiss CONSUMER layflat benchmarks (what a parent pays for a self-designed book, VAT incl, plus shipping):
- ifolor.ch Premium Photo Paper (layflat), A4 portrait: 26 pp CHF 42.95 list (38.65 sale), 36 pp CHF 56.95 list
  (51.25 sale), 60 pp CHF 90.55 list; shipping from CHF 5.95. ifolor.ch/en/photo-book/premium-photo-paper/a4/portrait/matt/matt/26-pages
- Saal Digital CH (layflat standard), 21x28: "ab SFr 29.90" (promo until 09.11.2026, page count of the "ab" price unstated),
  28x28 ab SFr 39.00; shipping extra, amount unstated. saal-digital.ch/fotobuch/
- Blurb UK layflat 8x10": £83.00 base + £2.67/page, shipping extra. blurb.co.uk/pricing
Reading: a CHF 59-69 layflat tier sits ~CHF 10-30 above a parent's DIY layflat cost at ifolor/Saal; whether it pays
depends on the Prodigi quote.
