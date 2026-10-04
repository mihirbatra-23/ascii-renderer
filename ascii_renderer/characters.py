"""Pre-render ASCII characters to bitmaps and build k-d tree for shape matching."""

import numpy as np
from scipy.spatial import KDTree
from PIL import Image, ImageDraw, ImageFont
from typing import List, Optional

from .config import RendererConfig
from .sampling import compute_sampling_vector


def _load_monospace_font(size: int) -> ImageFont.FreeTypeFont:
    """Try to load a monospace font, falling back gracefully."""
    font_names = [
        "Courier New",
        "CourierNew",
        "Courier",
        "DejaVu Sans Mono",
        "DejaVuSansMono",
        "Menlo",
        "Monaco",
        "Consolas",
        "Liberation Mono",
    ]
    for name in font_names:
        try:
            return ImageFont.truetype(name, size)
        except (OSError, IOError):
            continue
    # Try common paths on macOS / Linux
    paths = [
        "/System/Library/Fonts/Courier.dfont",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.dfont",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        "C:\\Windows\\Fonts\\cour.ttf",
    ]
    for path in paths:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


class CharacterAtlas:
    """
    Pre-computes 6D shape vectors for all candidate ASCII characters
    and builds a KDTree for fast nearest-neighbor lookup.
    """

    def __init__(self, config: Optional[RendererConfig] = None):
        self.config = config or RendererConfig()
        self.characters: List[str] = list(self.config.char_set)
        self.vectors: np.ndarray = None  # shape (num_chars, 6)
        self.kdtree: KDTree = None
        self.font: ImageFont.FreeTypeFont = _load_monospace_font(self.config.font_size)
        self._build()

    def _render_character_bitmap(self, char: str) -> np.ndarray:
        """
        Render a single character onto a cell-sized grayscale image.

        Returns:
            np.ndarray of shape (cell_height, cell_width), float32 in [0, 1].
        """
        cw = self.config.cell_width
        ch = self.config.cell_height
        img = Image.new("L", (cw, ch), color=0)
        draw = ImageDraw.Draw(img)

        # Get character bounding box for centering
        bbox = draw.textbbox((0, 0), char, font=self.font)
        char_w = bbox[2] - bbox[0]
        char_h = bbox[3] - bbox[1]
        x = (cw - char_w) / 2 - bbox[0]
        y = (ch - char_h) / 2 - bbox[1]

        draw.text((x, y), char, fill=255, font=self.font)
        return np.array(img, dtype=np.float32) / 255.0

    def _compute_character_vector(self, bitmap: np.ndarray) -> np.ndarray:
        """
        Compute the 6D shape vector for a character bitmap using
        the same internal sampling circles as used for image cells.
        """
        return compute_sampling_vector(
            bitmap,
            cell_x=0,
            cell_y=0,
            cell_w=self.config.cell_width,
            cell_h=self.config.cell_height,
            circles=self.config.internal_circles,
            num_samples=self.config.char_num_samples,
        )

    def _build(self):
        """Render all characters, compute shape vectors, build k-d tree."""
        raw_vectors = []
        for char in self.characters:
            bitmap = self._render_character_bitmap(char)
            vec = self._compute_character_vector(bitmap)
            raw_vectors.append(vec)

        self.vectors = np.array(raw_vectors, dtype=np.float32)

        # Normalize by global max so all values are in [0, 1]
        max_val = self.vectors.max()
        if max_val > 0:
            self.vectors = self.vectors / max_val

        self.kdtree = KDTree(self.vectors)

    def find_nearest(self, query_vector: np.ndarray) -> str:
        """Find the character whose shape vector is closest to query_vector."""
        _, idx = self.kdtree.query(query_vector, k=1)
        return self.characters[idx]

    def find_nearest_batch(self, query_vectors: np.ndarray) -> List[str]:
        """
        Batch nearest-neighbor query.

        Args:
            query_vectors: shape (N, 6)

        Returns:
            list of N character strings.
        """
        _, indices = self.kdtree.query(query_vectors, k=1)
        return [self.characters[i] for i in indices]
