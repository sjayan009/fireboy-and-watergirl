Fundamentals of Machine Learning, reviewed

Linear Classification (s = Wx + b)
 - s is the output
 - W is the Weight Matrix
 - x is the input matrix
 - b is for bias

For Data Preparation, mean centering AND normalization for scaling is very important.

What is the purpose of a Loss Function?
 - Good predictions equivalent to low loss
 - Bad predictions equivalent to high loss

Multiclass SVM Loss
 - Penalize models that make incorrect predictions AND if they predict correctly but not within the safe boundary

Softmax + Cross-Entropy Loss
 - Softmax transforms the scores into a set of probabilities that sums up to 1
 - Cross-Entropy: It calculates the penalty for a wrong or uncertain prediction using the negative log-likelihood

Optimizations --> Teaching the model how to improve

Activation Functions
 - Sigmoid
 - Tanh
 - ReLU
 - Leaky ReLU

Sigmoid transforms every real number into a number between 0 and 1.
 -> Problem: Vanishing Gradients because of if backpropagate with manyu layers gradients become small and learning becomes slow

 -> Problem: Not Zero Centered

Move to Tanh: 0-centered, because min and max is (-1, 1), but it could still produce vanishing gradients at large magnitudes.

ReLU (Rectified Linear Unit). Very cheap to compute. Uses derivatives. no positive side saturation, has sparse activations becomes negative inputs become zero
 - Weakness: Dying Neurons --> Fix this with Leaky ReLU.

