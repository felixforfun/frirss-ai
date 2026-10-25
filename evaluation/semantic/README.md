# Semantic ranking evaluation using real votes

This experiment uses an exported FriRSS vote history to test whether local Ollama embeddings help predict explicit upvotes versus downvotes. It does not change production code paths, ranking defaults, or the UI.

## Requirements

- A checkout of this repository with dependencies installed (npm install).
- A JSON vote export with the fields vote, title, summary, content, url, source, and createdAt or updatedAt.
- Ollama reachable from the machine running the script, with the chosen embedding model already pulled. The default model is bge-m3.

## Run

On the Unraid host, if the export is at the existing location:

    npm run eval:semantic -- --input /boot/config/plugins/user.scripts/frirss-votes.json --ollama-url http://127.0.0.1:11434

If the script runs inside a container, 127.0.0.1 means that container, not the Unraid host. Pass an Ollama URL reachable from that environment. Do not expose Ollama publicly just to run the experiment.

Useful options:

    npm run eval:semantic -- --help
    npm run eval:semantic -- --input ./frirss-votes.json --model bge-m3 --repeats 5 --folds 5 --out ./semantic-eval.md

The vector cache is stored outside the repository by default at ~/.cache/frirss-semantic-eval.sqlite. It is content-addressed and includes the Ollama model digest where available, so repeated runs reuse vectors. To clear it, stop the evaluation process and delete that cache file. The report is printed to stdout; --out also writes a Markdown copy.

## Input comparison

Every article is embedded using both inputs:

1. **Title + summary**: title capped at 2,000 characters and cleaned summary capped at 2,000 characters.
2. **Title + summary + lead**: the exact same input plus the first 1,000 characters of cleaned article content.

HTML tags and common entities are cleaned before embedding. The same model and normalization rules are used for both configurations. The cache is local and is not committed to Git.

## Methods

The evaluation calls the current repository implementations of Current and Intelligence Next, then compares:

- **Centroid**: cosine similarity to the mean positive vector minus cosine similarity to the mean negative vector.
- **kNN-15**: similarity-weighted vote among the 15 nearest training examples.
- **Multi-centroid**: up to five deterministic k-means centroids per class, using the maximum similarity to each class.
- **Hybrid**: blends Intelligence Next's held-out rank percentile with the semantic method's rank percentile at 25%, 50%, and 75% semantic influence.

Each method is evaluated with both input configurations.

## Evaluation design

- Duplicate canonical URLs with the same label are collapsed to avoid placing the same story in both training and test folds. URLs with conflicting labels are excluded and reported.
- Primary evaluation: repeated stratified 5-fold cross-validation (5 repeats by default). Each voted article is held out once per repeat.
- Secondary sensitivity check: train on the oldest 80% of votes and test on the latest 20%.
- ROC-AUC and average precision are reported with 95% class-stratified bootstrap intervals over unique articles. Precision@10 and NDCG@10 are averaged across the individual held-out folds.
- Publication timestamps, subscriptions, and saved-item signals are not available in the vote export. The evaluation keeps freshness neutral and does not supply subscription or saved-item context to the baselines.
- The script does not treat unvoted articles as negative examples.

## How to interpret the result

This is an initial, small-sample experiment—not proof of production ranking quality. The dataset contains only articles that the old system surfaced and that the reader chose to vote on, so selection bias remains. Votes are imbalanced and temporally clustered. Consider confidence intervals, the chronological sensitivity result, and the actual ranking metrics together; do not select a winner based on a tiny point-estimate difference.

A higher ROC-AUC means better separation of upvotes from downvotes within this selected set. Average precision should be compared with the positive-class prevalence. Because most examples are upvotes, random-ranking Precision@10 is already expected to be close to that prevalence. None of these metrics directly proves that the top of an unvoted feed will be better.

The evaluation makes no server, database-schema, frontend, settings, or production-ranking changes.
