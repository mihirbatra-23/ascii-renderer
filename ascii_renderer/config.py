"""All tunable parameters for the ASCII renderer."""

from dataclasses import dataclass, field
from typing import List, Tuple


@dataclass
class RendererConfig:
    # Cell geometry (pixels per character)
    cell_width: int = 10
    cell_height: int = 18  # monospace aspect ratio ~1.8

    # Sampling
    num_samples_per_circle: int = 64
    char_num_samples: int = 256  # higher accuracy for character precomputation

    # Internal sampling circles: 6 circles in a 2x3 staggered grid
    # Each tuple: (cx_frac, cy_frac, radius_frac) relative to cell dimensions
    internal_circles: List[Tuple[float, float, float]] = field(default_factory=lambda: [
        (0.30, 0.20, 0.28),  # top-left     [0]
        (0.70, 0.13, 0.28),  # top-right    [1]
        (0.30, 0.53, 0.28),  # mid-left     [2]
        (0.70, 0.47, 0.28),  # mid-right    [3]
        (0.30, 0.87, 0.28),  # bottom-left  [4]
        (0.70, 0.80, 0.28),  # bottom-right [5]
    ])

    # External sampling circles: 10 circles reaching into neighboring cells
    # Positions can be outside [0,1] — they sample adjacent cells
    external_circles: List[Tuple[float, float, float]] = field(default_factory=lambda: [
        (0.30, -0.15, 0.22),   # above top-left        [0]
        (0.70, -0.15, 0.22),   # above top-right       [1]
        (-0.15, 0.35, 0.22),   # left of mid-left      [2]
        (1.15, 0.35, 0.22),    # right of mid-right    [3]
        (-0.15, 0.70, 0.22),   # left of bottom-left   [4]
        (1.15, 0.70, 0.22),    # right of bottom-right [5]
        (-0.15, 1.05, 0.22),   # below-left            [6]
        (1.15, 1.05, 0.22),    # below-right           [7]
        (0.30, 1.15, 0.22),    # below bottom-left     [8]
        (0.70, 1.15, 0.22),    # below bottom-right    [9]
    ])

    # Which external circles affect each internal circle
    affecting_external_indices: List[List[int]] = field(default_factory=lambda: [
        [0, 1, 2, 4],      # affect internal[0] (top-left)
        [0, 1, 3, 5],      # affect internal[1] (top-right)
        [2, 4, 6],          # affect internal[2] (mid-left)
        [3, 5, 7],          # affect internal[3] (mid-right)
        [4, 6, 8, 9],       # affect internal[4] (bottom-left)
        [5, 7, 8, 9],       # affect internal[5] (bottom-right)
    ])

    # Contrast enhancement
    global_contrast_exponent: float = 2.0
    directional_contrast_exponent: float = 3.0

    # Cache
    cache_bits: int = 5  # 5 bits per dimension = 32 levels

    # Character set: all printable ASCII
    char_set: str = field(default_factory=lambda: "".join(chr(i) for i in range(32, 127)))

    # Font for character rendering and PNG output
    font_size: int = 14
    output_font_size: int = 10
    background_color: str = "black"
    text_color: str = "white"
