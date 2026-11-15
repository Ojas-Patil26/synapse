// Mock tutoring content for fixture mode: summaries, explanation material and
// quiz facts for every fixture concept. The real backend generates all of this
// with Gemini; nothing here is used when VITE_USE_FIXTURES is not "true".

export interface ConceptContent {
  /** 1-2 sentences. The first sentence doubles as the definition in quizzes. */
  summary: string;
  /** Three true statements. */
  points: [string, string, string];
  pitfall: string;
  example: string;
  /** A false statement, used for "which is false" questions. */
  myth: string;
  q: { prompt: string; options: [string, string, string, string]; answer: number; why: string };
}

export const CONTENT: Record<string, ConceptContent> = {
  "cse471-state-space-search": {
    summary:
      "State-space search models a problem as states, actions and a goal test, then explores the resulting graph for a path to a goal. BFS, DFS and uniform-cost search differ only in which frontier node they expand next.",
    points: [
      "A search problem is defined by an initial state, actions, a transition model, a goal test and a path cost.",
      "Breadth-first search is complete and finds the shallowest goal, but its memory grows exponentially with depth.",
      "Uniform-cost search expands the frontier node with the lowest path cost so far.",
    ],
    pitfall: "Forgetting to track visited states, so graph search re-expands the same state forever.",
    example: "Finding the fewest moves to solve an 8-puzzle by expanding board configurations level by level.",
    myth: "Depth-first search always returns the lowest-cost path.",
    q: {
      prompt: "The branching factor is b and the shallowest goal is at depth d. Roughly how many nodes does breadth-first search generate?",
      options: ["O(b·d)", "O(b^d)", "O(d^b)", "O(log d)"],
      answer: 1,
      why: "BFS generates every node down to depth d, which is b + b² + … + b^d = O(b^d).",
    },
  },
  "cse471-a-star": {
    summary:
      "A* search expands the node with the lowest f(n) = g(n) + h(n), the cost so far plus a heuristic estimate of the cost to go. With a good heuristic it reaches the optimal path while expanding far fewer nodes than uninformed search.",
    points: [
      "A* orders its frontier by f(n) = g(n) + h(n).",
      "With an admissible heuristic, A* tree search returns an optimal solution.",
      "With h(n) = 0 for every node, A* behaves exactly like uniform-cost search.",
    ],
    pitfall: "Ordering the frontier by h(n) alone, which is greedy best-first search and loses optimality.",
    example: "A maps app routing between two cities using straight-line distance to guide which roads to try first.",
    myth: "A* is optimal with any heuristic, including one that overestimates.",
    q: {
      prompt: "Two frontier nodes: A has g = 4, h = 3; B has g = 2, h = 6. Which does A* expand next?",
      options: ["A, because f = 7 is lower", "B, because g = 2 is lower", "B, because h = 6 is higher", "Either; A* picks at random"],
      answer: 0,
      why: "A* expands the lowest f = g + h. A has f = 7, B has f = 8.",
    },
  },
  "cse471-admissible-heuristics": {
    summary:
      "An admissible heuristic never overestimates the true cost to reach the goal. Admissibility is what lets A* guarantee an optimal answer.",
    points: [
      "A heuristic is admissible when h(n) is less than or equal to the true remaining cost for every node.",
      "Solving a relaxed version of the problem, with some rules removed, yields an admissible heuristic.",
      "A consistent heuristic satisfies h(n) ≤ cost(n, n') + h(n') and is always admissible.",
    ],
    pitfall: "Assuming a more aggressive heuristic is always better, even when it overestimates and breaks optimality.",
    example: "Using Manhattan distance for the 8-puzzle: each tile needs at least that many moves to get home.",
    myth: "A heuristic that sometimes overestimates is still admissible if it is right on average.",
    q: {
      prompt: "h1 and h2 are both admissible. Which combination is admissible and expands the fewest nodes?",
      options: ["h1 + h2", "min(h1, h2)", "max(h1, h2)", "h1 × h2"],
      answer: 2,
      why: "The maximum of two admissible heuristics never overestimates and dominates both, so A* expands no more nodes than with either alone.",
    },
  },
  "cse471-minimax": {
    summary:
      "Minimax picks the move that maximizes your outcome assuming the opponent then plays to minimize it. It evaluates a game tree bottom-up, alternating max and min levels.",
    points: [
      "MAX nodes take the largest child value and MIN nodes take the smallest.",
      "Minimax plays optimally against an optimal opponent in a deterministic, zero-sum game.",
      "Real programs cut the search off at a depth limit and score positions with an evaluation function.",
    ],
    pitfall: "Assuming the opponent will make a mistake, and choosing a move that only wins if they do.",
    example: "A tic-tac-toe program that looks ahead through every reply and never loses.",
    myth: "Minimax needs chance nodes to handle a deterministic two-player game.",
    q: {
      prompt: "A MAX root has two MIN children. Their leaves are (3, 12) and (2, 8). What is the minimax value of the root?",
      options: ["2", "3", "8", "12"],
      answer: 1,
      why: "The MIN nodes return min(3, 12) = 3 and min(2, 8) = 2. MAX takes the larger: 3.",
    },
  },
  "cse471-alpha-beta": {
    summary:
      "Alpha-beta pruning skips branches of a minimax tree that cannot change the final decision. It returns the same move as minimax while searching far fewer nodes.",
    points: [
      "Alpha is the best value MAX can already guarantee; beta is the best value MIN can already guarantee.",
      "A branch is pruned as soon as alpha is greater than or equal to beta.",
      "With perfect move ordering, alpha-beta searches roughly twice as deep as minimax in the same time.",
    ],
    pitfall: "Expecting pruning to change the answer; it changes only how much of the tree is searched.",
    example: "A chess engine that stops examining a move once it finds one reply that already refutes it.",
    myth: "Alpha-beta pruning can return a different move than plain minimax.",
    q: {
      prompt: "At a MIN node, alpha = 5 was passed down from above. The first child returns 3. What happens next?",
      options: [
        "The remaining children are pruned",
        "Alpha is updated to 3",
        "The node must still check every child",
        "The search restarts from the root",
      ],
      answer: 0,
      why: "MIN can now hold this node to 3 or less, but MAX already has 5 elsewhere. Since beta (3) ≤ alpha (5), nothing further here can matter.",
    },
  },
  "cse471-csp": {
    summary:
      "A constraint satisfaction problem asks for values for a set of variables such that every constraint holds. Its structure lets solvers prune with inference instead of searching blindly.",
    points: [
      "A CSP is defined by variables, a domain for each variable and constraints over them.",
      "Backtracking search assigns one variable at a time and undoes an assignment when a constraint fails.",
      "The minimum-remaining-values heuristic picks the variable with the fewest legal values left.",
    ],
    pitfall: "Choosing variables in a fixed order instead of the most constrained one, which explodes the search.",
    example: "Coloring a map so that no two neighboring regions share a color.",
    myth: "A CSP solution must minimize the path cost of the assignments.",
    q: {
      prompt: "What does forward checking do after a variable is assigned?",
      options: [
        "Removes inconsistent values from the domains of unassigned neighbors",
        "Reorders every variable by domain size",
        "Restarts the search with a new random assignment",
        "Proves that the problem has no solution",
      ],
      answer: 0,
      why: "Forward checking deletes neighbor values that conflict with the new assignment, so dead ends are detected one step earlier.",
    },
  },
  "cse471-mdp": {
    summary:
      "A Markov decision process models decisions whose outcomes are uncertain, using states, actions, transition probabilities, rewards and a discount factor. Solving one yields a policy: the best action for every state.",
    points: [
      "The Markov property says the next state depends only on the current state and action.",
      "The Bellman equation writes a state's value as immediate reward plus the discounted value of what follows.",
      "Value iteration applies the Bellman update repeatedly until the values converge.",
    ],
    pitfall: "Planning a single fixed path instead of a policy, even though actions can land in unintended states.",
    example: "A robot crossing an icy grid where each move has a 20% chance of slipping sideways.",
    myth: "In an MDP the agent always ends up in the state it intended to reach.",
    q: {
      prompt: "What does a discount factor γ close to 0 make an agent do?",
      options: [
        "Strongly prefer immediate rewards",
        "Value far-future rewards almost as much as immediate ones",
        "Ignore rewards entirely",
        "Explore at random",
      ],
      answer: 0,
      why: "A reward t steps away is multiplied by γ^t, so with small γ anything beyond the next step is worth almost nothing.",
    },
  },
  "cse471-q-learning": {
    summary:
      "Q-learning learns the value of taking each action in each state directly from experience, without a model of the environment. Each sample nudges the estimate toward the observed reward plus the best estimated future value.",
    points: [
      "Q-learning is model-free: it never needs the transition probabilities or the reward function.",
      "The update is Q(s,a) ← Q(s,a) + α[r + γ·max Q(s',a') − Q(s,a)].",
      "It is off-policy: it learns the optimal values even while following an exploratory policy.",
    ],
    pitfall: "Never exploring, so the agent locks onto the first action that happened to pay off.",
    example: "An agent learning to play Pac-Man purely by trial and error across thousands of games.",
    myth: "Q-learning must know the transition probabilities before it can update.",
    q: {
      prompt: "In ε-greedy Q-learning, what is ε for?",
      options: [
        "The probability of taking a random action to explore",
        "The learning rate applied to each update",
        "The discount applied to future rewards",
        "The threshold for stopping training",
      ],
      answer: 0,
      why: "With probability ε the agent ignores its current Q-values and tries a random action, so it keeps discovering better options.",
    },
  },
  "cse471-bayes-rule": {
    summary:
      "Bayes' rule turns a known P(evidence | cause) into the P(cause | evidence) you actually want. It is the basis for reasoning about hidden causes from what you can observe.",
    points: [
      "Bayes' rule states P(A|B) = P(B|A)·P(A) / P(B).",
      "The prior P(A) is your belief before seeing the evidence.",
      "P(B) normalizes the result so the posterior probabilities sum to 1.",
    ],
    pitfall: "Confusing P(A|B) with P(B|A), the base-rate fallacy.",
    example: "Working out the chance you have a disease after a positive test, given how rare the disease is.",
    myth: "P(A|B) and P(B|A) are always equal.",
    q: {
      prompt: "A disease affects 1% of people. A test catches 90% of cases and has a 10% false-positive rate. After a positive test, the chance of having the disease is closest to:",
      options: ["90%", "50%", "8%", "1%"],
      answer: 2,
      why: "P(D|+) = 0.9·0.01 / (0.9·0.01 + 0.1·0.99) ≈ 0.083. The low base rate dominates.",
    },
  },
  "cse471-bayes-nets": {
    summary:
      "A Bayesian network is a directed acyclic graph in which each variable stores a probability table conditioned on its parents. It represents a full joint distribution compactly by encoding independence.",
    points: [
      "The joint probability is the product of each node's probability given its parents.",
      "Each node is conditionally independent of its non-descendants given its parents.",
      "A network over n binary variables with few parents needs far fewer than 2^n numbers.",
    ],
    pitfall: "Reading an arrow as proof of causation; it encodes only a direct probabilistic dependence.",
    example: "Inferring whether a burglary happened from an alarm and two neighbors who may call.",
    myth: "A Bayesian network may contain directed cycles.",
    q: {
      prompt: "In the network A → B → C, what is true once B is observed?",
      options: [
        "A and C become independent",
        "A and C become dependent",
        "C no longer depends on B",
        "The network is no longer valid",
      ],
      answer: 0,
      why: "In a chain, observing the middle node blocks the path, so A tells you nothing more about C.",
    },
  },
  "cse475-linear-regression": {
    summary:
      "Linear regression fits a weighted sum of the input features to predict a continuous value. The weights are chosen to minimize squared error between predictions and targets.",
    points: [
      "The model predicts y = w·x + b.",
      "Ordinary least squares minimizes the sum of squared residuals.",
      "The squared-error loss is convex, so it has a single global minimum.",
    ],
    pitfall: "Extrapolating far outside the range of the training data and trusting the straight line.",
    example: "Predicting a house's price from its square footage and number of bedrooms.",
    myth: "Linear regression outputs a probability between 0 and 1.",
    q: {
      prompt: "Which loss does ordinary least squares minimize?",
      options: ["Mean squared error", "Cross-entropy", "Hinge loss", "0-1 loss"],
      answer: 0,
      why: "OLS picks the weights that minimize the squared differences between predictions and targets.",
    },
  },
  "cse475-gradient-descent": {
    summary:
      "Gradient descent minimizes a loss by repeatedly stepping the parameters in the direction of steepest decrease. The learning rate sets the size of each step.",
    points: [
      "Each step is w ← w − α·∇L(w).",
      "A learning rate that is too large can overshoot the minimum and diverge.",
      "Stochastic gradient descent estimates the gradient from a small batch instead of the whole dataset.",
    ],
    pitfall: "Leaving features unscaled, so one direction of the loss is far steeper and progress zig-zags.",
    example: "Tuning a model's weights by nudging each one slightly downhill on the error surface, thousands of times.",
    myth: "Gradient descent always finds the global minimum of any loss.",
    q: {
      prompt: "Training loss rises and oscillates wildly from the first few steps. What is the most likely fix?",
      options: ["Lower the learning rate", "Raise the learning rate", "Add more layers", "Remove the bias term"],
      answer: 0,
      why: "Oscillating, growing loss means the steps overshoot the minimum. Smaller steps restore convergence.",
    },
  },
  "cse475-logistic-regression": {
    summary:
      "Logistic regression is a linear classifier that passes a weighted sum through the sigmoid to output a class probability. It is trained by minimizing cross-entropy loss.",
    points: [
      "The sigmoid maps any real number into the range (0, 1).",
      "Its decision boundary is linear in the input features.",
      "Training minimizes cross-entropy, also called log loss.",
    ],
    pitfall: "Training it with squared error, which makes the loss non-convex and learning slow.",
    example: "Estimating the probability that an email is spam from counts of suspicious words.",
    myth: "Logistic regression can separate any dataset, however non-linear.",
    q: {
      prompt: "A logistic regression model computes w·x + b = 0 for an input. What probability does it output?",
      options: ["0", "0.5", "1", "It is undefined"],
      answer: 1,
      why: "sigmoid(0) = 1 / (1 + e⁰) = 0.5, which is exactly on the decision boundary.",
    },
  },
  "cse475-regularization": {
    summary:
      "Overfitting is when a model memorizes noise in the training data and performs worse on new data. Regularization fights it by penalizing complexity, typically large weights.",
    points: [
      "Overfitting shows up as low training error together with high validation error.",
      "L2 regularization adds the sum of squared weights to the loss.",
      "L1 regularization pushes some weights to exactly zero, producing sparse models.",
    ],
    pitfall: "Tuning the regularization strength on the test set, which leaks it into training.",
    example: "A degree-15 polynomial that threads every training point and swings wildly in between.",
    myth: "Lower training error always means a better model.",
    q: {
      prompt: "You increase the L2 penalty λ from a very small value. What typically happens?",
      options: [
        "Training error rises and variance falls",
        "Training error falls and variance rises",
        "Both training and test error always fall",
        "The model gains more parameters",
      ],
      answer: 0,
      why: "A stronger penalty restricts the weights, so the model fits the training data less closely but varies less between datasets.",
    },
  },
  "cse475-cross-validation": {
    summary:
      "Cross-validation estimates how a model will perform on unseen data by training and validating on different splits of the data. K-fold averages the result over k such splits.",
    points: [
      "In k-fold cross-validation each example is used for validation exactly once.",
      "It gives a more reliable estimate than a single train/validation split.",
      "It is commonly used to choose hyperparameters such as regularization strength.",
    ],
    pitfall: "Fitting preprocessing, such as feature scaling, on the full dataset before splitting.",
    example: "Comparing five values of λ by averaging validation error over 5 folds for each.",
    myth: "Cross-validation uses the test set to choose hyperparameters.",
    q: {
      prompt: "In 5-fold cross-validation, what fraction of the data trains the model in each round?",
      options: ["20%", "50%", "80%", "100%"],
      answer: 2,
      why: "One of the five folds is held out for validation, leaving four folds (80%) for training.",
    },
  },
  "cse475-naive-bayes": {
    summary:
      "Naive Bayes classifies by applying Bayes' rule under the assumption that features are conditionally independent given the class. It is simple, fast and surprisingly strong on text.",
    points: [
      "It assumes features are conditionally independent given the class.",
      "The class score is the prior times the product of per-feature likelihoods.",
      "Laplace smoothing prevents an unseen feature value from zeroing out the whole product.",
    ],
    pitfall: "Skipping smoothing, so a single unseen word drives a class probability to zero.",
    example: "A spam filter that multiplies per-word spam likelihoods to score a message.",
    myth: "Naive Bayes requires the features to be truly independent to work at all.",
    q: {
      prompt: "Why is Laplace (add-one) smoothing used in Naive Bayes?",
      options: [
        "To avoid zero probabilities for feature values never seen with a class",
        "To make the features independent",
        "To speed up training",
        "To normalize the input features",
      ],
      answer: 0,
      why: "Without smoothing, one unseen feature value gives a likelihood of 0 and wipes out the entire product.",
    },
  },
  "cse475-neural-networks": {
    summary:
      "A neural network stacks layers of weighted sums and non-linear activations to learn complex functions. Its hidden layers learn their own intermediate features from the data.",
    points: [
      "Each layer computes a weighted sum of its inputs followed by a non-linear activation.",
      "Without non-linear activations, any stack of layers collapses into a single linear model.",
      "With enough hidden units a network can approximate any continuous function.",
    ],
    pitfall: "Initializing every weight to the same value, so all hidden units learn the identical feature.",
    example: "Recognizing handwritten digits from raw pixel values.",
    myth: "Adding more layers always improves accuracy on new data.",
    q: {
      prompt: "Why does a network need non-linear activation functions?",
      options: [
        "Without them the whole network is equivalent to one linear layer",
        "They make training faster",
        "They remove the need for a loss function",
        "They guarantee a global minimum",
      ],
      answer: 0,
      why: "A composition of linear maps is itself linear, so depth adds no expressive power without a non-linearity.",
    },
  },
  "cse475-backpropagation": {
    summary:
      "Backpropagation computes the gradient of the loss with respect to every weight by applying the chain rule backward through the network. It makes training deep networks practical.",
    points: [
      "It applies the chain rule layer by layer, from the output back to the input.",
      "It reuses intermediate results, so all gradients cost about as much as one forward pass.",
      "It only computes gradients; an optimizer such as gradient descent then updates the weights.",
    ],
    pitfall: "Treating backpropagation as the weight update itself, when it only supplies the gradients.",
    example: "Working out how much each weight in a digit classifier contributed to one wrong prediction.",
    myth: "Backpropagation updates the weights without needing any gradients.",
    q: {
      prompt: "Which rule from calculus is backpropagation built on?",
      options: ["The chain rule", "The product rule only", "L'Hôpital's rule", "Integration by parts"],
      answer: 0,
      why: "The loss is a composition of layer functions, and the chain rule gives the derivative of a composition.",
    },
  },
  "cse475-decision-trees": {
    summary:
      "A decision tree classifies by asking a sequence of feature tests, each one splitting the data into purer groups. Splits are chosen greedily to maximize information gain.",
    points: [
      "Each split is chosen to maximize information gain, or equivalently to reduce impurity the most.",
      "A fully grown tree can fit the training data perfectly and overfit.",
      "Decision trees handle non-linear decision boundaries without any feature scaling.",
    ],
    pitfall: "Growing the tree until every leaf is pure, which memorizes noise in the training set.",
    example: "Deciding whether to approve a loan by checking income, then credit history, then debt.",
    myth: "Decision trees require features to be normalized first.",
    q: {
      prompt: "What does pruning a decision tree accomplish?",
      options: [
        "It reduces overfitting by removing branches that add little",
        "It increases training accuracy",
        "It adds features to the dataset",
        "It makes the splits non-greedy",
      ],
      answer: 0,
      why: "Pruned branches were mostly fitting noise, so removing them usually improves accuracy on new data.",
    },
  },
};

// A generic third course, used when a third or later course is uploaded in fixture mode.
export const EXTRA_COURSE = {
  industrySkills: ["Algorithm analysis", "Data structure selection", "Performance tuning", "Technical interviewing"],
  skillsSummary:
    "This course builds the ability to pick the right data structure for a workload and reason about its cost. Those skills carry directly into backend engineering and technical interviews.",
  concepts: [
    { key: "big-o", label: "Asymptotic Analysis", parent: null, stability: 2 },
    { key: "hash-tables", label: "Hash Tables", parent: null, stability: 2 },
    { key: "collisions", label: "Collision Resolution", parent: "hash-tables", stability: 2 },
    { key: "heaps", label: "Binary Heaps", parent: null, stability: 2 },
    { key: "graph-traversal", label: "Graph Traversal", parent: null, stability: 2 },
  ],
  edges: [
    { from: "big-o", to: "hash-tables", type: "prerequisite" as const },
    { from: "big-o", to: "heaps", type: "prerequisite" as const },
    { from: "heaps", to: "graph-traversal", type: "related" as const },
  ],
  content: {
    "big-o": {
      summary:
        "Asymptotic analysis describes how an algorithm's running time grows as its input grows. Big-O gives an upper bound that ignores constant factors.",
      points: [
        "Big-O notation drops constant factors and lower-order terms.",
        "O(n log n) grows faster than O(n) and slower than O(n²).",
        "Worst-case analysis bounds the running time over every input of a given size.",
      ],
      pitfall: "Comparing two algorithms by Big-O alone when the inputs are small and constants dominate.",
      example: "Showing that binary search needs about 20 steps for a million sorted items.",
      myth: "An O(n) algorithm is faster than an O(n²) algorithm on every input.",
      q: {
        prompt: "What is the running time of binary search on a sorted array of n items?",
        options: ["O(1)", "O(log n)", "O(n)", "O(n log n)"],
        answer: 1,
        why: "Each comparison halves the remaining range, so about log₂ n steps are needed.",
      },
    },
    "hash-tables": {
      summary:
        "A hash table stores key-value pairs in an array, using a hash function to pick each key's slot. Lookups, inserts and deletes take constant time on average.",
      points: [
        "A hash function maps a key to an array index.",
        "Average-case lookup is O(1) when the load factor is kept bounded.",
        "The table is resized and rehashed when the load factor grows too large.",
      ],
      pitfall: "Using a mutable object as a key and then changing it, so it can no longer be found.",
      example: "Counting how often each word appears in a document in a single pass.",
      myth: "A hash table keeps its keys in sorted order.",
      q: {
        prompt: "What is the worst-case lookup time in a hash table with chaining?",
        options: ["O(1)", "O(log n)", "O(n)", "O(n²)"],
        answer: 2,
        why: "If every key hashes to the same bucket, a lookup has to scan a chain of all n items.",
      },
    },
    collisions: {
      summary:
        "Collision resolution handles two keys that hash to the same slot. Chaining stores a list per slot, while open addressing probes for another free slot.",
      points: [
        "Chaining keeps a linked list of entries in each bucket.",
        "Linear probing checks the following slots one by one until it finds a free one.",
        "Open addressing degrades sharply as the load factor approaches 1.",
      ],
      pitfall: "Deleting an entry under open addressing without a tombstone, which breaks later lookups.",
      example: "Two usernames hashing to bucket 7 and being stored in that bucket's list.",
      myth: "A good hash function makes collisions impossible.",
      q: {
        prompt: "Which problem is linear probing especially prone to?",
        options: ["Primary clustering", "Stack overflow", "Unbalanced trees", "Hash function inversion"],
        answer: 0,
        why: "Occupied runs grow and merge, so new keys take longer and longer to place.",
      },
    },
    heaps: {
      summary:
        "A binary heap is a complete binary tree in which every parent is ordered before its children. It gives fast access to the minimum or maximum element.",
      points: [
        "In a min-heap every parent is less than or equal to its children.",
        "Insert and extract-min both take O(log n).",
        "A heap is stored compactly in an array, with the children of index i at 2i+1 and 2i+2.",
      ],
      pitfall: "Assuming a heap is fully sorted; only the root is guaranteed to be the extreme.",
      example: "A priority queue that always hands a scheduler the most urgent task.",
      myth: "Searching a heap for an arbitrary value takes O(log n).",
      q: {
        prompt: "How long does it take to build a heap from n unsorted items with the bottom-up method?",
        options: ["O(log n)", "O(n)", "O(n log n)", "O(n²)"],
        answer: 1,
        why: "Most nodes are near the bottom and sift down only a short distance, so the total work is linear.",
      },
    },
    "graph-traversal": {
      summary:
        "Graph traversal visits every vertex reachable from a start vertex. Breadth-first search explores level by level, and depth-first search follows one path as far as it can.",
      points: [
        "BFS uses a queue and finds shortest paths in unweighted graphs.",
        "DFS uses a stack or recursion and is the basis of topological sorting.",
        "Both run in O(V + E) time with an adjacency list.",
      ],
      pitfall: "Not marking vertices as visited, so a cycle causes an infinite loop.",
      example: "Finding the fewest connections between two people in a social network.",
      myth: "Depth-first search finds shortest paths in unweighted graphs.",
      q: {
        prompt: "Which data structure does breadth-first search use for its frontier?",
        options: ["Queue", "Stack", "Heap", "Hash table"],
        answer: 0,
        why: "A first-in, first-out queue makes BFS finish each level before starting the next.",
      },
    },
  } as Record<string, ConceptContent>,
};

const FALLBACK: ConceptContent = {
  summary: "A core idea from this course.",
  points: ["It appears throughout the course.", "Later topics build on it.", "It is worth reviewing regularly."],
  pitfall: "Memorizing the definition without working through an example.",
  example: "Applying the idea to a small worked problem from your notes.",
  myth: "It can be skipped without affecting later topics.",
  q: {
    prompt: "What is the most reliable way to keep this concept?",
    options: ["Spaced review and practice", "Rereading once", "Highlighting the notes", "Waiting until the exam"],
    answer: 0,
    why: "Spaced retrieval practice is what moves a concept into long-term memory.",
  },
};

export function contentFor(conceptId: string, extra: Record<string, ConceptContent>): ConceptContent {
  return CONTENT[conceptId] ?? extra[conceptId] ?? FALLBACK;
}

export function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : text;
}
