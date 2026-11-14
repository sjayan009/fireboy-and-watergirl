"""
CS231n-inspired ML FROM SCRATCH — fill-in-the-blanks practice file.
Scope: linear classifiers, losses, optimization, backpropagation,
fully connected neural networks, normalization, dropout, training.
EXCLUDED: CNNs and transfer learning.

Install: pip install numpy
Run: python ml_from_scratch.py

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

    # Goal: Get a probability distribution adds up to 1, even negative output vaues.

    # Subtract each row's max from that row (keeps exp from overflowing)
    # and subtract each row’s biggest number from that row.
    row = scores - np.max(scores, axis=1, keepdims = True)

    # Raising that entire row to e^row_i for each value.
    e_exp_row = np.exp(row)

    # Now, divide that by the sum of the row.
    row_sums = e_exp_row / np.sum(e_exp_row, axis=1, keepdims = True)

    return row_sums



def svm_loss(scores, y):
    """TODO 02: Multiclass hinge loss and dScores.
    margin = max(0, s_j - s_correct + 1) for j != correct.
    Average over N. Return (scalar_loss, gradient_same_shape_as_scores).
    """
    
    # Finding # of rows
    N = scores.shape[0]
    idx = np.arange(N)
    
    # 2. Getting the correct class score and converting to column vector
    correct_col = scores[idx, y][:, None]
    
    # 3. Calculate margins
    diff = scores - correct_col + 1
    margins = np.maximum(0, diff)
    
    # 4. Exclude the correct class from the loss calculation
    margins[idx, y] = 0
    
    # 5. Compute average loss over N
    loss = margins.sum() / N

    # 6. Compute the gradient (dScores)
    # Start by making a binary mask where margin > 0
    dScores = np.zeros_like(scores)
    dScores[margins > 0] = 1
    
    # For correct classes, the gradient is the negative sum of all active margins in that row
    dScores[idx, y] = -np.sum(dScores, axis=1)
    
    # Average the gradient over N to match the loss normalization
    dScores /= N

    return loss, dScores


    raise NotImplementedError('TODO 02')


def cross_entropy_loss(scores, y):
    """TODO 03: Softmax cross-entropy and dScores (stable).
    Return (scalar_loss, gradient). Hint: dScores = probs; subtract 1
    from the correct-class probability; divide by N.
    """

    # 1. Turn scores into probabilities
    
    N = scores.shape[0] # rows
    
    # 2. For each row, grab the probability of the CORRECT class (from y)
    probs = softmax(scores)
    
    # Getting the correct index
    idx = np.arange(N)
    corr_prob = probs[idx, y]
    
    # 3. Compute -ln(p) for each of those
    # 4. Average them (sum / number of rows)
    loss = np.sum(-np.log(corr_prob))/N

    # 5. Compute the gradient (dScores)
    dScores = probs.copy()
    dScores[idx, y] -= 1
    dScores /= N
    
    return loss, dScores


def linear_forward(X, W, b):
    """TODO 04: Compute class scores X @ W + b."""
    
    return X @ W + b


def linear_backward(X, W, dScores):
    """TODO 05: Return (dX, dW, db) for linear_forward.
    Hint: dW = X.T @ dScores; db = sum(dScores, axis=0).
    """
    dW = X.T @ dScores
    db = np.sum(dScores, axis=0)
    dX = dScores @ W.T
    return (dX, dW, db)


def relu_forward(X):
    """TODO 06: ReLU activation: max(0, X)."""
    return np.maximum(0, X)
    


def relu_backward(X, dout):
    """TODO 07: ReLU backward: pass gradient only where X > 0."""
    return dout * (X > 0)
    


def sigmoid(X):
    """TODO 08: Stable sigmoid 1/(1+exp(-X)); handle large magnitudes."""
    raise NotImplementedError('TODO 08')


def tanh_backward(X, dout):
    """TODO 09: Derivative of tanh: 1 - tanh(X)**2."""
    raise NotImplementedError('TODO 09')


def affine_relu_forward(X, W, b):
    """TODO 10: Compose affine + ReLU. Return (out, cache).
    cache must retain everything needed for backward.
    """
    raise NotImplementedError('TODO 10')


def affine_relu_backward(dout, cache):
    """TODO 11: Chain rule through ReLU then affine.
    Return (dX, dW, db).
    """
    raise NotImplementedError('TODO 11')


def initialize_mlp(layer_sizes, activation='relu', seed=42):
    """TODO 12: Return params dict W1,b1,...,WL,bL.
    layer_sizes e.g. [2, 32, 16, 3]. Use He initialization for ReLU
    (std=sqrt(2/fan_in)); Xavier for tanh (std=sqrt(1/fan_in)).
    Biases start at zero.
    """
    raise NotImplementedError('TODO 12')


def mlp_forward(X, params):
    """TODO 13: Arbitrary-depth fully connected network.
    Hidden layers: affine -> ReLU. Final layer: affine only (logits).
    Return (scores, caches). Reuse the layer functions above.
    """
    raise NotImplementedError('TODO 13')


def mlp_backward(scores, y, caches, params, reg=0.0):
    """TODO 14: Backpropagate softmax CE through every layer.
    Return (loss, grads_dict). Add L2 regularization:
      loss += 0.5 * reg * sum(W**2)
      dW += reg * W
    Do not regularize biases.
    """
    raise NotImplementedError('TODO 14')


def dropout_forward(X, drop_prob, rng, training=True):
    """TODO 15: Inverted dropout. Keep with prob 1-drop_prob;
    scale retained activations by 1/(1-drop_prob). Return (out, mask).
    In eval mode, return X unchanged.
    """
    raise NotImplementedError('TODO 15')


def dropout_backward(dout, mask):
    """TODO 16: Backprop through inverted dropout mask."""
    raise NotImplementedError('TODO 16')


def batchnorm_forward(X, gamma, beta, eps=1e-5):
    """TODO 17: Training-mode batch norm for 2D X (N,D).
    Compute per-feature mean, variance, normalized X, gamma*Xhat+beta.
    Return (out, cache). Extension: running stats for inference.
    """
    raise NotImplementedError('TODO 17')


def batchnorm_backward(dout, cache):
    """TODO 18: Return (dX, dgamma, dbeta).
    Derive gradients by the computational graph / chain rule.
    """
    raise NotImplementedError('TODO 18')


def sgd_step(params, grads, learning_rate):
    """TODO 19: In-place SGD update for every parameter."""
    raise NotImplementedError('TODO 19')


def momentum_step(params, grads, velocity, learning_rate, mu=0.9):
    """TODO 20: SGD + momentum. Update params and velocity in-place.
    velocity[k] = mu*velocity[k] - learning_rate*grads[k].
    """
    raise NotImplementedError('TODO 20')


def rmsprop_step(params, grads, cache, learning_rate, decay=0.99, eps=1e-8):
    """TODO 21: RMSProp: exponential moving average of squared grads."""
    raise NotImplementedError('TODO 21')


def adam_step(params, grads, m, v, t, learning_rate=1e-3,
              beta1=0.9, beta2=0.999, eps=1e-8):
    """TODO 22: Adam: first/second moments + bias correction.
    t starts at 1. Update params, m, v in-place.
    """
    raise NotImplementedError('TODO 22')


def accuracy(scores, y):
    """TODO 23: Fraction of argmax predictions equal to labels."""
    raise NotImplementedError('TODO 23')


def make_spiral(n_per_class=100, classes=3, noise=0.2, seed=0):
    """TODO 24: Generate 2D spiral classification data.
    Return X (N,2), y (N,). Hint: radius increases from 0 to 1;
    theta increases with radius, with class-dependent offsets + noise.
    """
    raise NotImplementedError('TODO 24')


def train(X_train, y_train, X_val, y_val, params, epochs=100,
          batch_size=64, lr=1e-2, reg=1e-3, seed=42):
    """TODO 25: Implement minibatch SGD training.
    For each epoch: shuffle, slice batches, forward, backward, update.
    Record training loss, train accuracy, val accuracy in a history dict.
    Do NOT update parameters using validation data.
    Extension: learning-rate decay, early stopping, Adam, grid search.
    """
    raise NotImplementedError('TODO 25')


def numerical_gradient(f, x, h=1e-5):
    """TODO 26: Central-difference gradient of scalar f(x) wrt array x.
    For each element: (f(x+h)-f(x-h))/(2*h); restore x after probing.
    """
    raise NotImplementedError('TODO 26')


def relative_error(a, b):
    """TODO 27: max(abs(a-b)/maximum(1e-8, abs(a)+abs(b)))."""
    raise NotImplementedError('TODO 27')


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
