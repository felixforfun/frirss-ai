# Consensus calibration report — `tau_story` / `tau_dup`

Sat, 2 Nov 2026. Result of the brief's Phase 3.4 calibration step (open item 5).
Review data: 51 pairs exported from the interactive pair review; owner labels below.

## Method

- Cohort: 300 most recent FreshRSS articles (`felix_entry`, published within 48 h,
  52 feeds), dumped from the live MariaDB.
- Embeddings: bge-m3 via OpenRouter (297 unique vectors; 3 articles were
  byte-identical duplicate DB rows). Text preprocessing and cache keys computed
  with the production code path (`server/semanticScoring.ts`, prep_version 1),
  so the measured similarities are exactly what Phase 3 will see.
- Census: all 44,850 pairwise cosines of the cohort.
- Sampling: 51 pairs stratified across similarity bins, weighted to the 0.6–0.9
  band where the story boundary lives (top bins are statistically thin: only
  9 cohort pairs total are ≥ 0.88; 5 ≥ 0.92).
- Labels: owner review in the interactive sheet. Judgment rule: same-story =
  same event (independent coverage, updates, commentary count); related =
  shared topic, different event; different = unrelated; `duplicate` note marks
  republications/wire copies (`tau_dup` axis).

## Label counts and spread

same-story 17, related 13, different 21 (51 total).

Same-story pairs: 0.7021 … 1.000 (median ≈ 0.848). Independent (no dup note):
13 pairs, 0.7021 … 0.9618. Duplicate-marked: 4 pairs, 0.9958 … 1.000.
Non-story pairs (related ∪ different): max 0.9143, and ≥ 0.6018 for the top three
false-positive risks: a pair of FAZ political stories (0.9143), two different
Mein-Deal products (0.8354), two unrelated travel deals (0.8175).

## Threshold trade-off (raw pair level)

| tau_story | merged pairs (non-story ≥ tau) | split pairs (story < tau) |
|---|---|---|
| 0.70 | 14 | 0 |
| 0.75 | 10 | 1 |
| 0.79 | 4 | 1 |
| 0.80 | 4 | 2 |
| 0.82 | 2 | 5 |
| 0.84 | 1 | 5 |

## Why 0.79 — the publisher-collapsed view

The consensus metric counts **origins** (independent publishers), so the cost
of a raw-pair error depends on whether the two sides share a publisher:
same-publisher pairs collapse into one origin regardless, so merging or
splitting them does not distort origin counts; cross-publisher errors do.

Every merge error at tau = 0.79 is a same-publisher pair:

- #9 FAZ×FAZ (0.9143, different) — see the boilerplate finding below
- #19 Mein-Deal×Mein-Deal (0.8354, different products)
- #14 Urlaubspiraten×Urlaubspiraten (0.8175, different destinations)
- #16 WELT×WELT (0.8026, two quotes from the same coverage) — borderline

and the single split (#30 FAZ×FAZ, 0.7021) is same-publisher too. **At
tau_story = 0.79 every misclassified pair involves one publisher → the origins
metric is not affected by any of these five errors.** Meanwhile every
cross-publisher pair ≥ 0.79 in the review set is genuinely same-story (Hannover
trial WELT/FAZ 0.9618; supermarket-cyberattack Slashdot/BleepingComputer/NZZ
0.84–0.87; Nordnet FAZ/WELT 0.847; 42AI Techmeme/TechCrunch 0.8485; Binance
hack The Conversation/NZZ 0.79–0.81; bull-donkey Conversation/SciAm 0.9006;
nuclear-alert hacks Register/Record 0.8912).

The apparently better table row (0.84: 1 merge) is strictly worse for the
metric: its five splits include three cross-publisher Binance-hack pairs
(0.79–0.81, The Conversation/NZZ) — exactly the real independent coverage the
signal exists to measure.

**Committed constants:**

```
TAU_STORY = 0.79
TAU_DUP   = 0.98
```

tau_dup derivation: duplicate-marked pairs are 0.9958–1.000; the highest
same-story pair without a dup note is 0.9618 (WELT/FAZ, different headlines).
Gap midpoint ≈ 0.979 → 0.98. Copy republication is additionally (and more
robustly) caught by the same-publisher rule and wire-agency markers, so a dup
copy with slightly edited text below 0.98 does not silently become an
independent origin.

## Finding: publisher feed boilerplate inflates same-publisher similarity

FAZ's feed content includes a "Empfehlungen Video Merken" block plus a teaser
of the *next* article (verified in the decompressed `content_bin`), so two
different FAZ stories contain each other's text and land at 0.9143 while being
unrelated stories. Same-pattern risk applies wherever feeds embed cross-teasers.

Impact assessment: for consensus this is largely self-absorbing (the majority
of boilerplate merges happen between same-publisher pairs, which collapse to a
single origin anyway). It remains a real, measurable prep-quality issue:

- Recommendation: keep `clean()` behavior unchanged for ranking parity, and
  handle boilerplate as a Phase 6 calibration topic (e.g., remove content
  nodes that are byte-identical across most articles of the same publisher
  before embedding) rather than changing the calibrated tau on this cohort.
- The Tau values above were derived on data as-is; if prep changes, tau must
  be re-derived.

## Honest limits

- N = 51, single labeler, one 48 h cross-section. The 0.70–0.75 band has too
  few labels to claim a precise boundary; the 0.79 choice is a judgment call
  between 0.75 and 0.82 trades, biased by the origin-collapse argument.
- Agglomerative average-linkage at the cluster level will smooth individual
  borderline pairs (e.g., Binance 0.7912 may still join the cluster through
  its 0.80–0.81 links). Threshold is applied to linkage distance, not raw pair
  similarity.
- Re-calibrate in Phase 6 with the shadow logs and a larger stratified sample
  (and any change to embedding prep or clustering).

Artifacts: `pairs-review.json` (51 pair payloads), `frirss-consensus-labels-2026-11-02.json`
(owner export), `histogram.json` (cohort census summary).
