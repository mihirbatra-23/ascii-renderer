"""Main rendering pipeline: image -> ASCII art."""

import io
import numpy as np
from PIL import Image
from typing import Optional

from .config import RendererConfig
from .sampling import relative_luminance, compute_all_vectors
from .characters import CharacterAtlas
from .contrast import apply_global_contrast, apply_directional_contrast
from .cache import QuantizedCache
from .renderer import render_to_text, render_to_png_bytes, render_to_svg_bytes


class AsciiPipeline:
    """
    Complete pipeline from input image to ASCII output.

    Initialization (once):
      - Build CharacterAtlas (precompute shape vectors + k-d tree)
      - Initialize cache

    Rendering (per image):
      1. Load image -> luminance array
      2. Scale to fit max_width characters
      3. Compute 6D internal + 10D external sampling vectors
      4. Apply global contrast enhancement
      5. Apply directional contrast enhancement
      6. Normalize and look up characters via k-d tree (cached)
      7. Return text + PNG
    """

    def __init__(self, config: Optional[RendererConfig] = None):
        self.config = config or RendererConfig()
        self.atlas = CharacterAtlas(self.config)
        self.cache = QuantizedCache(bits=self.config.cache_bits)

    def _load_luminance(self, image: Image.Image) -> np.ndarray:
        """Convert a PIL Image to a luminance array."""
        rgb = image.convert("RGB")
        arr = np.array(rgb, dtype=np.float32) / 255.0
        return relative_luminance(arr)

    def render(
        self,
        image_path: str = None,
        image_bytes: bytes = None,
        max_width: int = 120,
    ) -> dict:
        """
        Full rendering pipeline.

        Args:
            image_path: path to input image.
            image_bytes: raw image bytes (e.g. from web upload).
            max_width: maximum number of character columns.

        Returns:
            dict with keys: text, png_bytes, grid, rows, cols, cache_stats
        """
        # 1. Load image
        if image_bytes:
            image = Image.open(io.BytesIO(image_bytes))
        elif image_path:
            image = Image.open(image_path)
        else:
            raise ValueError("Provide either image_path or image_bytes")

        image = image.convert("RGB")

        # 2. Scale image so output is max_width characters wide
        cw = self.config.cell_width     # 10
        ch = self.config.cell_height    # 18
        cols = max_width
        # Compensate for character aspect ratio: each cell is ch/cw pixels
        # tall but renders as a ~square character. Divide by char_aspect
        # so circles stay circular and proportions are preserved.
        char_aspect = ch / cw
        rows = max(1, int((image.height / image.width) * cols / char_aspect))

        target_pixel_w = cols * cw
        target_pixel_h = rows * ch
        image = image.resize((target_pixel_w, target_pixel_h), Image.LANCZOS)
        luminance = self._load_luminance(image)
        if rows == 0 or cols == 0:
            return {
                "text": "",
                "png_bytes": b"",
                "grid": [],
                "rows": 0,
                "cols": 0,
                "cache_stats": self.cache.stats(),
            }

        # 4. Compute sampling vectors for all cells
        internal, external = compute_all_vectors(
            luminance,
            rows,
            cols,
            cw,
            ch,
            self.config.internal_circles,
            self.config.external_circles,
            self.config.num_samples_per_circle,
        )

        # 5. Global contrast enhancement
        flat = internal.reshape(-1, internal.shape[-1])
        flat = apply_global_contrast(flat, self.config.global_contrast_exponent)
        internal = flat.reshape(rows, cols, -1)

        # 6. Directional contrast enhancement
        internal = apply_directional_contrast(
            internal,
            external,
            self.config.affecting_external_indices,
            self.config.directional_contrast_exponent,
        )

        # 7. Normalize to [0, 1]
        max_val = internal.max()
        if max_val > 0:
            internal = internal / max_val

        # 8. Character lookup with caching
        grid = []
        for r in range(rows):
            row = []
            for c in range(cols):
                vec = internal[r, c]
                char = self.cache.get(vec)
                if char is None:
                    char = self.atlas.find_nearest(vec)
                    self.cache.put(vec, char)
                row.append(char)
            grid.append(row)

        # 9. Produce outputs
        text = render_to_text(grid)
        png_bytes = render_to_png_bytes(
            grid,
            font_size=self.config.output_font_size,
            bg_color=self.config.background_color,
            fg_color=self.config.text_color,
        )
        svg_bytes = render_to_svg_bytes(
            grid,
            font_size=self.config.output_font_size,
            bg_color=self.config.background_color,
            fg_color=self.config.text_color,
        )

        return {
            "text": text,
            "png_bytes": png_bytes,
            "svg_bytes": svg_bytes,
            "grid": grid,
            "rows": rows,
            "cols": cols,
            "cache_stats": self.cache.stats(),
        }
