10-21-2026.MD Continuation

# Neural Network Architecture

## 1. Big Picture
- A neural network is a function that learns to map inputs to outputs.
- It learns by adjusting **weights** and **biases** to produce better predictions.
- Neural networks extend linear classifiers by stacking layers with **nonlinear activation functions**.
- **Architecture** describes how the layers and neurons are arranged; **training** determines their weights.

## 2. Neurons
- A neuron receives inputs, multiplies them by weights, adds a bias, and applies an activation function.
- **Weights** determine the influence of inputs.
- **Biases** allow a neuron to shift its response.
- **Activation functions** determine how the neuron transforms its combined input.
- Basic idea: `output = activation(weighted_sum + bias)`.

## 3. Layers
- **Input layer:** receives raw features (e.g., image pixels).
- **Hidden layers:** learn intermediate patterns or representations.
- **Output layer:** produces predictions, such as class scores.
- A **fully connected (dense) layer** connects every neuron in one layer to every neuron in the next.
- The **forward pass** moves data through the network to produce an output.

## 4. Why Nonlinearity Matters
- Without nonlinear activation functions, stacking linear layers is equivalent to using a single linear transformation.
- Nonlinearity lets the network learn complex relationships and nonlinear decision boundaries.
- This is what makes depth useful, rather than merely adding more matrix multiplications.

## 5. Activation Functions
- **ReLU:** outputs zero for negative inputs and leaves positive inputs unchanged; a common default for hidden layers.
- **Sigmoid:** maps values to 0–1; often used for binary output probabilities and gates. Can suffer from vanishing gradients.
- **Tanh:** maps values to -1–1; zero-centered but can also suffer from vanishing gradients.
- **Leaky ReLU:** allows a small negative output/slope for negative inputs; helps with inactive ReLU neurons.
- **Maxout:** selects the maximum of learned linear functions; flexible but uses more parameters.
- **Modern context:** GELU and SiLU are common in newer architectures.
- **Softmax:** turns class scores into a probability distribution across mutually exclusive classes; generally used at the output, not as a hidden-layer activation.

## 6. Depth, Width, and Capacity
- **Width:** number of neurons in a layer.
- **Depth:** number of learned layers; conventions vary on whether the input layer is counted.
- **Capacity:** how complex a function the model can represent.
- Increasing width or depth generally increases representational capacity, but also increases computational cost.
- Deeper layers can combine simpler patterns into more abstract features.
- Bigger networks are not automatically better: data, optimization, architecture, and generalization matter.

## 7. Representational Power
- Neural networks can approximate a wide range of nonlinear functions when given sufficient capacity.
- This is related to the **universal approximation theorem**.
- The theorem does **not** guarantee easy training, perfect generalization, or that a practical model will learn the desired function.
- Depth can represent certain patterns more efficiently than a very wide shallow network.

## 8. Architecture Example
```text
Input features (e.g., image pixels)
        ↓
Fully connected layer
        ↓
ReLU activation
        ↓
Fully connected layer
        ↓
Class scores
        ↓
Predicted class
```
- Each fully connected layer learns weights and biases.
- The hidden layer learns a representation; the final layer maps that representation to class scores.
- For multiclass classification, class scores can be converted to probabilities using softmax.

## 9. Key Distinctions
- **Weights/biases:** parameters learned during training.
- **Number of layers/neurons:** architecture hyperparameters chosen before or during experimentation.
- **Activation:** function applied within a neuron or layer.
- **Loss function:** measures prediction error; belongs to training, not the architecture itself.
- **Optimizer:** uses gradients to update parameters; also belongs to training.
- **Training vs. inference:** training updates weights; inference uses learned weights to make predictions.

## 10. Takeaways
1. A neuron = weighted inputs + bias + activation.
2. A network = neurons arranged in layers.
3. Nonlinear activations make neural networks more expressive than linear classifiers.
4. Depth and width control the model's architecture and capacity.
5. Hidden layers learn representations; output layers produce predictions.
6. Architecture specifies **what the model can learn**; optimization and data influence **what it actually learns**.
