"""
python/train.py
Train a Logistic Regression model to predict the next draw's sum
using a sliding window of the last 5 draws.

Usage:
    cd bingo-ai
    pip install -r python/requirements.txt
    python python/train.py
"""
import json
import os
import sys
import warnings
warnings.filterwarnings('ignore')

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.metrics import classification_report

DATA_FILE = os.path.join(os.path.dirname(__file__), '..', 'dataset', 'history.json')
WINDOW    = 5
MIN_ROWS  = WINDOW + 15   # need enough samples for cross-val


def load_data(path: str) -> list:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_dataset(data: list, window: int = WINDOW):
    """
    Features for row i:  last `window` sums + n1/n2/n3 values
    Label:               data[i]['sum']
    """
    X, y = [], []
    for i in range(window, len(data)):
        w = data[i - window:i]
        features = (
            [r['sum'] for r in w] +
            [r['n1']  for r in w] +
            [r['n2']  for r in w] +
            [r['n3']  for r in w]
        )
        X.append(features)
        y.append(data[i]['sum'])
    return np.array(X, dtype=float), np.array(y, dtype=int)


def main():
    # ── Load ───────────────────────────────────────────────────────────────
    if not os.path.exists(DATA_FILE):
        print(f'[train] ERROR: {DATA_FILE} not found.')
        print('        Run `node crawler/crawl.js` first.')
        sys.exit(1)

    data = load_data(DATA_FILE)
    print(f'[train] Loaded {len(data)} records')

    if len(data) < MIN_ROWS:
        print(f'[train] ERROR: need at least {MIN_ROWS} records, got {len(data)}.')
        sys.exit(1)

    X, y = build_dataset(data)
    print(f'[train] Feature matrix: {X.shape}  |  classes: {sorted(set(y))}')

    # ── Cross-validation ───────────────────────────────────────────────────
    model  = LogisticRegression(max_iter=2000, multi_class='multinomial',
                                solver='lbfgs', C=1.0, random_state=42)
    cv_acc = cross_val_score(model, X, y, cv=min(5, len(X) // 3), scoring='accuracy')
    print(f'[train] CV accuracy: {cv_acc.mean():.4f} ± {cv_acc.std():.4f}')

    # ── Fit on all data ────────────────────────────────────────────────────
    model.fit(X, y)

    # ── Predict next draw ──────────────────────────────────────────────────
    next_pred = model.predict([X[-1]])[0]
    proba     = model.predict_proba([X[-1]])[0]
    cls_idx   = list(model.classes_).index(next_pred)

    print(f'[train] Next sum prediction: {next_pred}  (confidence: {proba[cls_idx]:.2%})')
    print('[train] Done — use export_model.py to save the model.')


if __name__ == '__main__':
    main()
