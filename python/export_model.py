"""
python/export_model.py
Train, evaluate and export the model to python/model.pkl.
Also writes python/prediction.json so Node.js can consume the result.

Usage:
    python python/export_model.py
"""
import json
import os
import sys
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import joblib
from sklearn.linear_model import LogisticRegression

DATA_FILE  = os.path.join(os.path.dirname(__file__), '..', 'dataset', 'history.json')
MODEL_FILE = os.path.join(os.path.dirname(__file__), 'model.pkl')
PRED_FILE  = os.path.join(os.path.dirname(__file__), 'prediction.json')
WINDOW     = 5


def load_data(path: str) -> list:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_dataset(data: list, window: int = WINDOW):
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
    if not os.path.exists(DATA_FILE):
        print(f'[export] ERROR: {DATA_FILE} not found — run crawler first.')
        sys.exit(1)

    data = load_data(DATA_FILE)
    if len(data) < WINDOW + 5:
        print(f'[export] ERROR: need at least {WINDOW + 5} records.')
        sys.exit(1)

    X, y = build_dataset(data)

    model = LogisticRegression(max_iter=2000, multi_class='multinomial',
                               solver='lbfgs', C=1.0, random_state=42)
    model.fit(X, y)

    # ── Save model ─────────────────────────────────────────────────────────
    joblib.dump(model, MODEL_FILE)
    print(f'[export] Model saved → {MODEL_FILE}')

    # ── Export prediction JSON for Node.js ─────────────────────────────────
    last_features = X[-1].tolist()
    next_sum      = int(model.predict([last_features])[0])
    proba         = model.predict_proba([last_features])[0]

    output = {
        'generatedAt':     __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'nextSumPredicted': next_sum,
        'confidence':      round(float(proba[list(model.classes_).index(next_sum)]), 4),
        'classes':         [int(c) for c in model.classes_],
        'probabilities':   {str(int(c)): round(float(p), 4)
                            for c, p in zip(model.classes_, proba)},
        'modelFile':       MODEL_FILE,
    }

    with open(PRED_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)
    print(f'[export] Prediction exported → {PRED_FILE}')
    print(f'[export] Next sum: {next_sum}  (confidence: {output["confidence"]:.2%})')


if __name__ == '__main__':
    main()
