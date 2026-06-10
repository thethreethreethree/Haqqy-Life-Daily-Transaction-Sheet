# Haqqy Life · Daily Trip Sheet

A clean web-app replacement for **Haqqy Life Boracay**'s daily **trip
cash-reconciliation spreadsheet** (the "BIHOPA / BBA" sheets). Each trip on each
day is one **trip sheet**: record the guests, fees, drink sales and expenses, and
the app derives every total — payment-method breakdown, revenue, expenses, and the
trust-critical **NET / Remit cash** and **Short / Over** — the same way the
spreadsheet's formulas did, but without the fragile manual cells.

No build step, no framework, no server required. It's a single static web app
(vanilla JS ES modules + custom CSS) that runs from IndexedDB and hosts on
**GitHub Pages**. Styled to match haqqy.life (Poppins · gold `#e0a240` on charcoal),
and modeled on the Frendz Front Desk Tracker, trimmed to this domain.

---

## What it computes (verified against the source sheet)

Everything derived is computed in [`app/compute.js`](app/compute.js), a faithful
reconstruction of the spreadsheet's formulas:

1. **Pricing engine.** A route has two base prices (BIHOPA `₱1,490 / ₱1,990`,
   BBA `₱1,990 / ₱2,190`). Each sales channel's price is **derived**, never typed:
   - Regular = Base 1 · 10% discount = Base 1 × 0.9 · 20% reattendee = Base 1 × 0.8
   - Paypal = Base 1 · OTA Klook / GYG = Base 2 × 0.8 · OTA KKday = Base 2 × 0.85
2. **Payment-method revenue.** `cash`, `cc`, `paypal`, `OTA` = Σ(channel price ×
   guests) split by how each guest paid, plus drink sales → **grand total**.
3. **Revenue ledger** (cash side) and **Expense ledger** — Description · unit ·
   amount · line total — each with a running total.
4. **NET = Revenue − Expenses** → the **Remit cash** figure (the locked headline,
   analogous to Cash-On-Hand in Frendz; derived, never editable).
5. **Cash count.** Peso denominations + Gcash → counted total → **Short (−) /
   Over (+)** vs. the expected remit.
6. **Magic Island ticket inventory** — on hand = inventory − consumed + purchased.

The test in [`test/compute.test.mjs`](test/compute.test.mjs) reproduces the real
**May 2 BIHOPA** sheet exactly: grand total `16,798` · revenue `21,720` · expenses
`7,828` · NET `13,892` · 11 guests — and checks BBA's derived prices.

```bash
node test/compute.test.mjs        # → 16 passed, 0 failed
```

---

## The trip lifecycle

- A trip sheet is **Open** (fully editable) while you fill it in.
- **Finalise** locks it read-only and records the remit figures (who & when).
- A locked sheet can be **Reopened** (with a reason) for corrections — also recorded.

## Activity log (tamper-evident)

Every meaningful action (create / finalise / reopen / delete a trip, edit a route,
import, reset, backup) is written to an **append-only, hash-chained activity log**:
`hash = sha256(event + previousHash)`. If the stored log is edited out of band the
chain breaks and the app shows **"chain broken @ #N"**. (Trip *sheets* are editable
working documents and are not individually hash-chained.)

---

## Run it locally

```bash
node serve.mjs          # → http://localhost:3000
```

First launch runs a one-time setup (app name + your name) and seeds the BIHOPA and
BBA routes. Edit prices or add routes any time in **Settings**.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Source: "Deploy from a branch"**, branch `main`, folder `/`.
3. Open the published URL. It's all static files.

## Data & backup

- **Live data** lives in the browser's IndexedDB on the device (localStorage
  fallback for private mode).
- **GitHub backup (built in).** In *Settings → GitHub backup* set owner/repo/branch/
  path, paste a fine-grained token (Contents: Read & write), then **Back up now**,
  or tick **Auto-backup on change**. Each backup is a commit, so Git history is a
  durable, dated off-device audit trail. The token is stored only on the device and
  is never included in any export.
- **Local file backup.** *Settings → Export backup* downloads a JSON snapshot;
  **Import backup** restores it.

---

## Project layout

```
index.html            App shell (loads styles + the ES-module app)
styles.css            Haqqy Life styling (gold #e0a240 / charcoal · Poppins)
serve.mjs             Tiny static dev server
brand_assets/         Haqqy Life logos + favicon (downloaded from haqqy.life)
app/
  util.js             Helpers + verified SHA-256 + formatting + el()
  compute.js          PURE calculation core (pricing, revenue, expenses, NET, short/over)
  store.js            Engine: routes, trips CRUD, finalize/lock, hash-chained activity log, IndexedDB
  github.js           GitHub Contents-API backup
  components.js        Modal / confirm / prompt / page header
  main.js             Bootstrap, setup, nav, settings (routes · backup · data)
  views/
    trips.js          Trip history list + monthly roll-up
    sheet.js          The trip sheet editor — all blocks, live recalculation
    activity.js       The hash-chained activity log
test/
  compute.test.mjs    Verifies the calc core against the real sheet
```

## Routes & pricing

| Route | Base 1 (regular) | Base 2 (OTA) |
|-------|------------------|--------------|
| BIHOPA | ₱1,490 | ₱1,990 |
| BBA | ₱1,990 | ₱2,190 |

Routes and base prices are editable in Settings; the channel discounts are global
and derived automatically.
