"""
python/ml_predictor.py
======================
Gradient Boosting combo predictor — offline training tool.

Trains 3 separate position classifiers (n1, n2, n3) on rich lag features,
then computes P(combo a-b-c) = P(n1=a) × P(n2=b) × P(n3=c) to score
all 216 possible combos.

Outputs python/ml_output.json which the Node.js ensemble (Model D) can
optionally load as a score prior.  The pure-JS k-NN in predictor/model_d.js
is the primary production Model D; this script provides a GBM-based
complement for offline validation and optional hybrid scoring.

Usage:
    pip install -r python/requirements.txt
    python python/ml_predictor.py
"""

import datetime
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import cross_val_score

DATA_FILE   = os.path.join(os.path.dirname(__file__), '..', 'dataset', 'history.json')
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), 'ml_output.json')

WINDOW   = 10          # lag window size (number of prior draws as features)
MIN_ROWS = WINDOW + 50  # minimum records for reliable training


# ── Data loading ──────────────────────────────────────────────────────────────

def load_data(path: str) -> list:
    with open(path, 'r', encoding='utf-8') as f:
        raw = json.load(f)
    # Ensure chronological order (oldest first)
    return sorted(raw, key=lambda r: int(r.get('ky', 0)))


def get_hour(draw_time: str) -> int:
    """Extract UTC+7 hour from ISO drawTime string; default 12 if missing."""
    if not draw_time:
        return 12
    try:
        dt = datetime.datetime.fromisoformat(draw_time.replace('Z', '+00:00'))
        return dt.hour
    except Exception:
        return 12


def encode_pattern(n1: int, n2: int, n3: int) -> int:
    """Encode draw pattern: 0=normal, 1=pair, 2=triple."""
    if n1 == n2 == n3:
        return 2
    if n1 == n2 or n2 == n3 or n1 == n3:
        return 1
    return 0


# ── Feature engineering ───────────────────────────────────────────────────────

def build_features(data: list, window: int = WINDOW):
    """
    Build (X, y_n1, y_n2, y_n3) for supervised learning.

    Feature vector dimensions (total = 5*window + 2 + 6 + 6 = 5w+14):
      lag_sum  [window]   — sum values of last `window` draws
      lag_n1   [window]   — n1 digit values
      lag_n2   [window]   — n2 digit values
      lag_n3   [window]   — n3 digit values
      lag_pat  [window]   — pattern codes (0/1/2)
      hour_sin, hour_cos  — cyclic encoding of current draw hour
      digit_cnt [6]       — how often each digit appeared across all 3 positions
      digit_gap [6]       — draws since each digit (1-6) last appeared anywhere
    """
    X, y_n1, y_n2, y_n3 = [], [], [], []

    for i in range(window, len(data)):
        w   = data[i - window:i]
        cur = data[i]

        lag_sum = [r['sum'] for r in w]
        lag_n1  = [r['n1']  for r in w]
        lag_n2  = [r['n2']  for r in w]
        lag_n3  = [r['n3']  for r in w]
        lag_pat = [encode_pattern(r['n1'], r['n2'], r['n3']) for r in w]

        hour     = get_hour(cur.get('drawTime'))
        hour_sin = float(np.sin(2 * np.pi * hour / 24))
        hour_cos = float(np.cos(2 * np.pi * hour / 24))

        # Count appearances of each digit (1-6) across all 3 positions in window
        all_digits = lag_n1 + lag_n2 + lag_n3
        digit_cnt  = [all_digits.count(d) for d in range(1, 7)]

        # Draws since each digit last appeared in any position
        last_seen: dict = {}
        for j, r in enumerate(w):
            for d in (r['n1'], r['n2'], r['n3']):
                last_seen[d] = j
        digit_gap = [window - last_seen.get(d, -1) - 1 for d in range(1, 7)]

        feats = (
            lag_sum + lag_n1 + lag_n2 + lag_n3 + lag_pat +
            [hour_sin, hour_cos] +
            digit_cnt +
            digit_gap
        )

        X.append(feats)
        y_n1.append(cur['n1'])
        y_n2.append(cur['n2'])
        y_n3.append(cur['n3'])

    return (
        np.array(X, dtype=float),
        np.array(y_n1, dtype=int),
        np.array(y_n2, dtype=int),
        np.array(y_n3, dtype=int),
    )


# ── Model ─────────────────────────────────────────────────────────────────────

def make_gbm() -> GradientBoostingClassifier:
    return GradientBoostingClassifier(
        n_estimators=200,
        learning_rate=0.05,
        max_depth=3,
        subsample=0.8,
        random_state=42,
    )


def train(X: np.ndarray, y: np.ndarray, name: str) -> GradientBoostingClassifier:
    model    = make_gbm()
    n_splits = min(5, max(2, len(X) // 30))
    if n_splits >= 2:
        cv = cross_val_score(model, X, y, cv=n_splits, scoring='accuracy')
        print(f'[ml] {name:<4}  CV acc: {cv.mean():.4f} ± {cv.std():.4f}  '
              f'(n={len(X)}, splits={n_splits})')
    model.fit(X, y)
    return model


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_combos(m_n1, m_n2, m_n3, x_last: np.ndarray) -> dict:
    """
    P(combo a-b-c) = P(n1=a) × P(n2=b) × P(n3=c).
    Falls back to uniform 1/6 for any digit not seen during training.
    """
    p1 = dict(zip(m_n1.classes_, m_n1.predict_proba([x_last])[0]))
    p2 = dict(zip(m_n2.classes_, m_n2.predict_proba([x_last])[0]))
    p3 = dict(zip(m_n3.classes_, m_n3.predict_proba([x_last])[0]))

    scores = {}
    for a in range(1, 7):
        for b in range(1, 7):
            for c in range(1, 7):
                scores[f'{a}-{b}-{c}'] = (
                    float(p1.get(a, 1 / 6)) *
                    float(p2.get(b, 1 / 6)) *
                    float(p3.get(c, 1 / 6))
                )
    return scores


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not os.path.exists(DATA_FILE):
        print(f'[ml] ERROR: {DATA_FILE} not found — run `node crawler/crawl.js` first.')
        sys.exit(1)

    data = load_data(DATA_FILE)
    print(f'[ml] Loaded {len(data)} records (sorted chronologically)')

    if len(data) < MIN_ROWS:
        print(f'[ml] WARNING: only {len(data)} records — need {MIN_ROWS} for reliable training.')
        print('[ml] Continuing anyway (results may be noisy with so few samples)…')

    X, y_n1, y_n2, y_n3 = build_features(data)
    print(f'[ml] Feature matrix: {X.shape}  '
          f'({X.shape[1]} features × {X.shape[0]} samples)')

    m_n1 = train(X, y_n1, 'n1')
    m_n2 = train(X, y_n2, 'n2')
    m_n3 = train(X, y_n3, 'n3')

    scores = score_combos(m_n1, m_n2, m_n3, X[-1])

    # Preview top-10
    top10 = sorted(scores.items(), key=lambda x: -x[1])[:10]
    print('[ml] Top-10 GBM combos:')
    for rank, (combo, s) in enumerate(top10, 1):
        print(f'       #{rank:2d}  {combo}  p={s:.8f}')

    output = {
        'generatedAt':  datetime.datetime.utcnow().isoformat() + 'Z',
        'trainRecords': len(data),
        'featureCount': int(X.shape[1]),
        'model':        'GradientBoosting(n=200,lr=0.05,depth=3)',
        'scores':       {k: round(v, 8) for k, v in scores.items()},
    }

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, separators=(',', ':'))

    print(f'[ml] Saved → {OUTPUT_FILE}')
    print('[ml] Done.  Load in Node.js via predictor/ml_bridge.js for hybrid scoring.')


if __name__ == '__main__':
    main()
