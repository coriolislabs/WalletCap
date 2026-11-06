# Vendor benchmark disclosure policy

This policy covers findings about **vendor products** in the Agent Payment
Benchmark. It is separate from walletcap's own 90-day policy in
[SECURITY.md](../SECURITY.md).

## The notice

Before publishing a named benchmark result, we send a **7-day pre-publication
notice** to the vendor's security contact, the product owner, and the relevant
executive. The notice includes:

- the affected product and version;
- the configuration tested;
- the measured impact;
- a private reproduction package;
- the exact publication date and time;
- an offer of a technical call within 48 hours.

We publish on the stated date whether or not the vendor replies. If the vendor
replies, their statement is included verbatim in the benchmark's response
column.

## Status labels

- **Unpatched** — no fixed public release as of the publication timestamp.
- **Acknowledged** — the vendor replied; a fix is in progress.
- **Fix in review** — a public PR or release candidate exists.
- **Fixed** — re-tested on the fixed release; the date and version are shown.
- **Disputed** — the vendor disagrees; their response and our evidence are both
  published.
- **No response** — the notice was delivered; no reply by the publication date.

## What we do not do

- We do not change a status because a vendor buys an evaluation, a re-test, or a
  CI gate. The benchmark publishes regardless.
- We do not publish a vendor's private data or a customer's identity.
- We do not treat an in-review report as a public finding before the notice
  window. Until publication, the public material uses counts and classes, not
  vendor names or routes.

## Re-tests

Every benchmark entry has a publication timestamp and the exact version tested.
When a vendor ships a fix, we re-test and update the entry. The paid evaluation
and annual CI gate are the productized form of that re-test, not a condition of
the label.
