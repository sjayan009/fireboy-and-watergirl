"""
CS231n-inspired ML FROM SCRATCH — fill-in-the-blanks practice file.
Scope: linear classifiers, losses, optimization, backpropagation,
fully connected neural networks, normalization, dropout, training.
EXCLUDED: CNNs and transfer learning.

Install: pip install numpy
Run: python ml_from_scratch_nn.py

How to use:
  1. Implement TODOs in order; do not use autograd or sklearn models.
  2. Each function has a short contract and hints.
  3. Run the tests at the bottom after each section.
  4. Set RUN_TRAINING=True when all implementations are complete.

Notation: X (N,D), W (D,C), b (C,), y (N,), scores (N,C).
"""
import numpy as np

RNG = np.random.default_rng(42)


def softmax(scores):
    """TODO 01: Stable softmax. Subtract row max; exponentiate; normalize rows."""
    z = scores - scores.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def svm_loss(scores, y):
    """TODO 02: Multiclass hinge loss and dScores.
    margin = max(0, s_j - s_correct + 1) for j != correct.
    Average over N. Return (scalar_loss, gradient_same_shape_as_scores).
    """
    N = scores.shape[0]
    idx = np.arange(N)
    margins = np.maximum(0, scores - scores[idx, y][:, None] + 1)
    margins[idx, y] = 0
    loss = margins.sum() / N
    active = (margins > 0).astype(scores.dtype)
    active[idx, y] = -active.sum(axis=1)
    return loss, active / N


def cross_entropy_loss(scores, y):
    """TODO 03: Softmax cross-entropy and dScores (stable).
    Return (scalar_loss, gradient). Hint: dScores = probs; subtract 1
    from the correct-class probability; divide by N.
    """
    N = scores.shape[0]
    idx = np.arange(N)
    probs = softmax(scores)
    loss = -np.log(probs[idx, y]).mean()
    d = probs.copy()
    d[idx, y] -= 1
    return loss, d / N


def linear_forward(X, W, b):
    """TODO 04: Compute class scores X @ W + b."""
    return X @ W + b


def linear_backward(X, W, dScores):
    """TODO 05: Return (dX, dW, db) for linear_forward.
    Hint: dW = X.T @ dScores; db = sum(dScores, axis=0).
    """
    return dScores @ W.T, X.T @ dScores, dScores.sum(axis=0)


def relu_forward(X):
    """TODO 06: ReLU activation: max(0, X)."""
    return np.maximum(0, X)


def relu_backward(X, dout):
    """TODO 07: ReLU backward: pass gradient only where X > 0."""
    return dout * (X > 0)


def sigmoid(X):
    """TODO 08: Stable sigmoid 1/(1+exp(-X)); handle large magnitudes."""
    e = np.exp(-np.abs(X))  # never overflows
    return np.where(X >= 0, 1 / (1 + e), e / (1 + e))


def tanh_backward(X, dout):
    """TODO 09: Derivative of tanh: 1 - tanh(X)**2."""
    return dout * (1 - np.tanh(X) ** 2)


def affine_relu_forward(X, W, b):
    """TODO 10: Compose affine + ReLU. Return (out, cache).
    cache must retain everything needed for backward.
    """
    a = linear_forward(X, W, b)
    return relu_forward(a), (X, W, a)


def affine_relu_backward(dout, cache):
    """TODO 11: Chain rule through ReLU then affine.
    Return (dX, dW, db).
    """
    X, W, a = cache
    return linear_backward(X, W, relu_backward(a, dout))


def initialize_mlp(layer_sizes, activation='relu', seed=42):
    """TODO 12: Return params dict W1,b1,...,WL,bL.
    layer_sizes e.g. [2, 32, 16, 3]. Use He initialization for ReLU
    (std=sqrt(2/fan_in)); Xavier for tanh (std=sqrt(1/fan_in)).
    Biases start at zero.
    """
    rng = np.random.default_rng(seed)
    params = {}
    for i, (fan_in, fan_out) in enumerate(zip(layer_sizes[:-1], layer_sizes[1:]), 1):
        scale = 2.0 if activation == 'relu' else 1.0
        params[f'W{i}'] = rng.normal(size=(fan_in, fan_out)) * np.sqrt(scale / fan_in)
        params[f'b{i}'] = np.zeros(fan_out)
    return params


def mlp_forward(X, params):
    """TODO 13: Arbitrary-depth fully connected network.
    Hidden layers: affine -> ReLU. Final layer: affine only (logits).
    Return (scores, caches). Reuse the layer functions above.
    """
    L = len(params) // 2
    caches = []
    out = X
    for i in range(1, L):
        out, cache = affine_relu_forward(out, params[f'W{i}'], params[f'b{i}'])
        caches.append(cache)
    caches.append((out, params[f'W{L}']))  # final layer: no ReLU
    return linear_forward(out, params[f'W{L}'], params[f'b{L}']), caches


def mlp_backward(scores, y, caches, params, reg=0.0):
    """TODO 14: Backpropagate softmax CE through every layer.
    Return (loss, grads_dict). Add L2 regularization:
      loss += 0.5 * reg * sum(W**2)
      dW += reg * W
    Do not regularize biases.
    """
    L = len(params) // 2
    loss, dout = cross_entropy_loss(scores, y)
    grads = {}
    Xl, Wl = caches[-1]
    dout, grads[f'W{L}'], grads[f'b{L}'] = linear_backward(Xl, Wl, dout)
    for i in range(L - 1, 0, -1):
        dout, grads[f'W{i}'], grads[f'b{i}'] = affine_relu_backward(dout, caches[i - 1])
    for i in range(1, L + 1):
        loss += 0.5 * reg * np.sum(params[f'W{i}'] ** 2)
        grads[f'W{i}'] += reg * params[f'W{i}']
    return loss, grads


def dropout_forward(X, drop_prob, rng, training=True):
    """TODO 15: Inverted dropout. Keep with prob 1-drop_prob;
    scale retained activations by 1/(1-drop_prob). Return (out, mask).
    In eval mode, return X unchanged.
    """
    if not training or drop_prob == 0:
        return X, None
    mask = (rng.random(X.shape) >= drop_prob) / (1 - drop_prob)
    return X * mask, mask


def dropout_backward(dout, mask):
    """TODO 16: Backprop through inverted dropout mask."""
    return dout if mask is None else dout * mask


def batchnorm_forward(X, gamma, beta, eps=1e-5):
    """TODO 17: Training-mode batch norm for 2D X (N,D).
    Compute per-feature mean, variance, normalized X, gamma*Xhat+beta.
    Return (out, cache). Extension: running stats for inference.
    """
    mu = X.mean(axis=0)
    var = X.var(axis=0)
    inv_std = 1 / np.sqrt(var + eps)
    xhat = (X - mu) * inv_std
    return gamma * xhat + beta, (xhat, gamma, inv_std)


def batchnorm_backward(dout, cache):
    """TODO 18: Return (dX, dgamma, dbeta).
    Derive gradients by the computational graph / chain rule.
    """
    xhat, gamma, inv_std = cache
    N = dout.shape[0]
    dgamma = (dout * xhat).sum(axis=0)
    dbeta = dout.sum(axis=0)
    dxhat = dout * gamma
    dX = inv_std / N * (N * dxhat - dxhat.sum(axis=0) - xhat * (dxhat * xhat).sum(axis=0))
    return dX, dgamma, dbeta


def sgd_step(params, grads, learning_rate):
    """TODO 19: In-place SGD update for every parameter."""
    for k in params:
        params[k] -= learning_rate * grads[k]


def momentum_step(params, grads, velocity, learning_rate, mu=0.9):
    """TODO 20: SGD + momentum. Update params and velocity in-place.
    velocity[k] = mu*velocity[k] - learning_rate*grads[k].
    """
    for k in params:
        velocity[k] = mu * velocity[k] - learning_rate * grads[k]
        params[k] += velocity[k]


def rmsprop_step(params, grads, cache, learning_rate, decay=0.99, eps=1e-8):
    """TODO 21: RMSProp: exponential moving average of squared grads."""
    for k in params:
        cache[k] = decay * cache[k] + (1 - decay) * grads[k] ** 2
        params[k] -= learning_rate * grads[k] / (np.sqrt(cache[k]) + eps)


def adam_step(params, grads, m, v, t, learning_rate=1e-3,
              beta1=0.9, beta2=0.999, eps=1e-8):
    """TODO 22: Adam: first/second moments + bias correction.
    t starts at 1. Update params, m, v in-place.
    """
    for k in params:
        m[k] = beta1 * m[k] + (1 - beta1) * grads[k]
        v[k] = beta2 * v[k] + (1 - beta2) * grads[k] ** 2
        mhat = m[k] / (1 - beta1 ** t)
        vhat = v[k] / (1 - beta2 ** t)
        params[k] -= learning_rate * mhat / (np.sqrt(vhat) + eps)


def accuracy(scores, y):
    """TODO 23: Fraction of argmax predictions equal to labels."""
    return float(np.mean(np.argmax(scores, axis=1) == y))


def make_spiral(n_per_class=100, classes=3, noise=0.2, seed=0):
    """TODO 24: Generate 2D spiral classification data.
    Return X (N,2), y (N,). Hint: radius increases from 0 to 1;
    theta increases with radius, with class-dependent offsets + noise.
    """
    rng = np.random.default_rng(seed)
    N = n_per_class * classes
    X = np.zeros((N, 2))
    y = np.zeros(N, dtype=int)
    for c in range(classes):
        sl = slice(c * n_per_class, (c + 1) * n_per_class)
        r = np.linspace(0.0, 1.0, n_per_class)
        t = np.linspace(c * 4, (c + 1) * 4, n_per_class) + rng.normal(size=n_per_class) * noise
        X[sl] = np.c_[r * np.sin(t), r * np.cos(t)]
        y[sl] = c
    return X, y


def train(X_train, y_train, X_val, y_val, params, epochs=100,
          batch_size=64, lr=1e-2, reg=1e-3, seed=42):
    """TODO 25: Implement minibatch SGD training.
    For each epoch: shuffle, slice batches, forward, backward, update.
    Record training loss, train accuracy, val accuracy in a history dict.
    Do NOT update parameters using validation data.
    Extension: learning-rate decay, early stopping, Adam, grid search.
    """
    rng = np.random.default_rng(seed)
    history = {'loss': [], 'train_acc': [], 'val_acc': []}
    N = X_train.shape[0]
    for _ in range(epochs):
        order = rng.permutation(N)
        losses = []
        for s in range(0, N, batch_size):
            b = order[s:s + batch_size]
            scores, caches = mlp_forward(X_train[b], params)
            loss, grads = mlp_backward(scores, y_train[b], caches, params, reg)
            sgd_step(params, grads, lr)
            losses.append(loss)
        history['loss'].append(float(np.mean(losses)))
        history['train_acc'].append(accuracy(mlp_forward(X_train, params)[0], y_train))
        history['val_acc'].append(accuracy(mlp_forward(X_val, params)[0], y_val))
    return history


def numerical_gradient(f, x, h=1e-5):
    """TODO 26: Central-difference gradient of scalar f(x) wrt array x.
    For each element: (f(x+h)-f(x-h))/(2*h); restore x after probing.
    """
    grad = np.zeros_like(x, dtype=float)
    it = np.nditer(x, flags=['multi_index'])
    for _ in it:
        i = it.multi_index
        old = x[i]
        x[i] = old + h
        fp = f(x)
        x[i] = old - h
        fm = f(x)
        x[i] = old
        grad[i] = (fp - fm) / (2 * h)
    return grad


def relative_error(a, b):
    """TODO 27: max(abs(a-b)/maximum(1e-8, abs(a)+abs(b)))."""
    a, b = np.asarray(a), np.asarray(b)
    return np.max(np.abs(a - b) / np.maximum(1e-8, np.abs(a) + np.abs(b)))


def run_smoke_tests():
    """Run incremental checks. Comment out tests for unfinished TODOs."""
    x = np.array([[1., 2., 3.], [-1., 0., 1.]])
    p = softmax(x)
    assert p.shape == x.shape and np.allclose(p.sum(axis=1), 1)
    assert np.all(p >= 0)
    loss, ds = cross_entropy_loss(x, np.array([2, 0]))
    assert np.isfinite(loss) and ds.shape == x.shape
    assert np.allclose(ds.sum(axis=1), 0)
    svm, g = svm_loss(x, np.array([2, 0]))
    assert svm >= 0 and g.shape == x.shape
    assert np.allclose(relu_forward(np.array([-2., 0., 3.])), [0, 0, 3])
    assert np.allclose(relu_backward(np.array([-2., 0., 3.]), np.ones(3)), [0, 0, 1])
    params = initialize_mlp([2, 8, 3])
    assert params['W1'].shape == (2, 8) and params['W2'].shape == (8, 3)
    X = RNG.normal(size=(5, 2)); y = RNG.integers(0, 3, size=5)
    scores, caches = mlp_forward(X, params)
    assert scores.shape == (5, 3)
    loss, grads = mlp_backward(scores, y, caches, params, reg=0.01)
    assert np.isfinite(loss) and all(grads[k].shape == params[k].shape for k in params)
    # Gradient check one weight (excellent way to debug backprop):
    analytical = grads['W1'].copy()
    def objective(w):
        old = params['W1']; params['W1'] = w
        try:
            s, c = mlp_forward(X, params)
            return mlp_backward(s, y, c, params, reg=0.01)[0]
        finally:
            params['W1'] = old
    numerical = numerical_gradient(objective, params['W1'].copy())
    assert relative_error(analytical, numerical) < 1e-5, 'Backprop gradient mismatch'
    print('Core tests passed!')


RUN_TRAINING = False
if __name__ == '__main__':
    run_smoke_tests()
    if RUN_TRAINING:
        X, y = make_spiral()
        idx = RNG.permutation(len(y)); split = int(0.8 * len(y))
        train_idx, val_idx = idx[:split], idx[split:]
        params = initialize_mlp([2, 64, 64, 3])
        history = train(X[train_idx], y[train_idx], X[val_idx], y[val_idx],
                        params, epochs=300, lr=0.05)
        print('Final history:', {k: v[-1] for k, v in history.items()})
