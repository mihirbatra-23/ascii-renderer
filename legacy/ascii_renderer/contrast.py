"""Global and directional contrast enhancement."""

import numpy as np
from typing import List


def apply_global_contrast(vectors: np.ndarray, exponent: float) -> np.ndarray:
    """
    Global contrast enhancement on sampling vectors.

    For each vector: normalize by max component, raise to power, denormalize.
    This pulls darker values toward zero more strongly than lighter values.

    Args:
        vectors: shape (N, D) — flattened array of sampling vectors.
        exponent: power to raise normalized values to (e.g. 2.0).

    Returns:
        Contrast-enhanced vectors, same shape.
    """
    result = vectors.copy()
    for i in range(result.shape[0]):
        max_val = result[i].max()
        if max_val > 0:
            result[i] = result[i] / max_val
            result[i] = np.power(result[i], exponent)
            result[i] = result[i] * max_val
    return result


def apply_directional_contrast(
    internal: np.ndarray,
    external: np.ndarray,
    affecting_indices: List[List[int]],
    exponent: float,
) -> np.ndarray:
    """
    Directional contrast enhancement using neighboring cell context.

    For each cell and each internal component, use the maximum of
    relevant external sampling values as the normalization reference.
    This sharpens edges by amplifying differences at cell boundaries.

    Args:
        internal: shape (rows, cols, 6) — internal sampling vectors.
        external: shape (rows, cols, 10) — external sampling vectors.
        affecting_indices: for each internal index, which external indices affect it.
        exponent: power for contrast (e.g. 3.0).

    Returns:
        Enhanced internal vectors, same shape.
    """
    result = internal.copy()
    rows, cols, n_internal = result.shape

    for r in range(rows):
        for c in range(cols):
            for i in range(n_internal):
                val = result[r, c, i]
                # Get max of relevant external values
                ext_indices = affecting_indices[i]
                ext_vals = external[r, c, ext_indices]
                max_ref = max(val, ext_vals.max())

                if max_ref > 0:
                    normalized = val / max_ref
                    enhanced = np.power(normalized, exponent)
                    result[r, c, i] = enhanced * max_ref

    return result
