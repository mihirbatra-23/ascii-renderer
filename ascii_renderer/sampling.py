"""Compute 6D/10D sampling vectors from image regions using circular sampling."""

import numpy as np
from typing import List, Tuple


def relative_luminance(rgb: np.ndarray) -> np.ndarray:
    """
    Convert an RGB image array to relative luminance.

    Args:
        rgb: float32 array of shape (H, W, 3), values in [0, 1].

    Returns:
        float32 array of shape (H, W), values in [0, 1].
    """
    return 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]


def generate_circle_offsets(num_samples: int) -> np.ndarray:
    """
    Generate uniformly distributed points within a unit circle (radius=1, center=0,0).
    Uses concentric rings with Shirley mapping for uniform distribution.

    Returns:
        np.ndarray of shape (num_samples, 2) with (dx, dy) offsets in [-1, 1].
    """
    offsets = []
    # Use concentric rings: sqrt distribution for uniform area coverage
    rings = max(1, int(np.sqrt(num_samples)))
    points_per_ring = max(1, num_samples // rings)

    count = 0
    for ring_i in range(rings):
        r = (ring_i + 0.5) / rings  # radius of this ring
        n_points = points_per_ring if ring_i < rings - 1 else (num_samples - count)
        for j in range(n_points):
            angle = 2.0 * np.pi * j / n_points + (ring_i * 0.5)  # offset angle per ring
            dx = r * np.cos(angle)
            dy = r * np.sin(angle)
            offsets.append((dx, dy))
            count += 1
            if count >= num_samples:
                break
        if count >= num_samples:
            break

    # Pad if needed
    while len(offsets) < num_samples:
        offsets.append((0.0, 0.0))

    return np.array(offsets, dtype=np.float32)


# Pre-generated offsets for common sample counts
_offset_cache = {}


def _get_offsets(num_samples: int) -> np.ndarray:
    """Get cached circle offsets."""
    if num_samples not in _offset_cache:
        _offset_cache[num_samples] = generate_circle_offsets(num_samples)
    return _offset_cache[num_samples]


def compute_sampling_vector(
    luminance: np.ndarray,
    cell_x: int,
    cell_y: int,
    cell_w: int,
    cell_h: int,
    circles: List[Tuple[float, float, float]],
    num_samples: int,
) -> np.ndarray:
    """
    Compute an N-dimensional sampling vector for one grid cell.

    For each circle defined by (cx_frac, cy_frac, radius_frac):
      1. Convert to absolute pixel coordinates within the cell.
      2. Sample points uniformly within the circle.
      3. Average the luminance at all valid sample points.

    Args:
        luminance: (H, W) float32 array, values in [0, 1].
        cell_x, cell_y: top-left pixel of the cell.
        cell_w, cell_h: cell dimensions in pixels.
        circles: list of (cx_frac, cy_frac, radius_frac) tuples.
        num_samples: number of sample points per circle.

    Returns:
        np.ndarray of shape (len(circles),) with values in [0, 1].
    """
    img_h, img_w = luminance.shape
    offsets = _get_offsets(num_samples)
    result = np.zeros(len(circles), dtype=np.float32)

    for i, (cx_frac, cy_frac, r_frac) in enumerate(circles):
        # Convert fractional positions to absolute pixel coords
        abs_cx = cell_x + cx_frac * cell_w
        abs_cy = cell_y + cy_frac * cell_h
        abs_r = r_frac * min(cell_w, cell_h)

        # Compute sample pixel coordinates
        sample_x = (abs_cx + offsets[:, 0] * abs_r).astype(np.int32)
        sample_y = (abs_cy + offsets[:, 1] * abs_r).astype(np.int32)

        # Clamp to image bounds
        sample_x = np.clip(sample_x, 0, img_w - 1)
        sample_y = np.clip(sample_y, 0, img_h - 1)

        # Average luminance at sample points
        result[i] = luminance[sample_y, sample_x].mean()

    return result


def compute_all_vectors(
    luminance: np.ndarray,
    rows: int,
    cols: int,
    cell_w: int,
    cell_h: int,
    internal_circles: List[Tuple[float, float, float]],
    external_circles: List[Tuple[float, float, float]],
    num_samples: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Compute internal and external sampling vectors for all cells in the grid.

    Returns:
        internal_vectors: shape (rows, cols, 6)
        external_vectors: shape (rows, cols, 10)
    """
    n_internal = len(internal_circles)
    n_external = len(external_circles)
    internal = np.zeros((rows, cols, n_internal), dtype=np.float32)
    external = np.zeros((rows, cols, n_external), dtype=np.float32)

    for r in range(rows):
        for c in range(cols):
            cx = c * cell_w
            cy = r * cell_h
            internal[r, c] = compute_sampling_vector(
                luminance, cx, cy, cell_w, cell_h, internal_circles, num_samples
            )
            external[r, c] = compute_sampling_vector(
                luminance, cx, cy, cell_w, cell_h, external_circles, num_samples
            )

    return internal, external
