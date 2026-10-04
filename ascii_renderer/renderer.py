"""Render ASCII art as text and as a PNG image."""

import io
import html as html_module
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from typing import List

from .characters import _load_monospace_font


def render_to_text(grid: List[List[str]]) -> str:
    """Convert a 2D character grid to a multi-line string."""
    return "\n".join("".join(row) for row in grid)


def render_to_png_bytes(
    grid: List[List[str]],
    font_size: int = 10,
    bg_color: str = "black",
    fg_color: str = "white",
    padding: int = 10,
) -> bytes:
    """
    Render the ASCII character grid to a PNG image.

    Returns:
        PNG image as bytes.
    """
    font = _load_monospace_font(font_size)

    # Measure character dimensions
    temp_img = Image.new("RGB", (100, 100))
    temp_draw = ImageDraw.Draw(temp_img)
    bbox = temp_draw.textbbox((0, 0), "M", font=font)
    char_w = bbox[2] - bbox[0]
    char_h = bbox[3] - bbox[1]

    if not grid or not grid[0]:
        return b""

    rows = len(grid)
    cols = len(grid[0])

    # Line height with a small gap
    line_h = int(char_h * 1.15)

    img_w = padding * 2 + cols * char_w
    img_h = padding * 2 + rows * line_h

    img = Image.new("RGB", (img_w, img_h), color=bg_color)
    draw = ImageDraw.Draw(img)

    for r, row in enumerate(grid):
        line = "".join(row)
        y = padding + r * line_h
        draw.text((padding, y), line, fill=fg_color, font=font)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_to_png_file(
    grid: List[List[str]],
    output_path: str,
    font_size: int = 10,
    bg_color: str = "black",
    fg_color: str = "white",
    padding: int = 10,
) -> str:
    """Render to a PNG file. Returns the output path."""
    data = render_to_png_bytes(grid, font_size, bg_color, fg_color, padding)
    with open(output_path, "wb") as f:
        f.write(data)
    return output_path


def render_to_svg_bytes(
    grid: List[List[str]],
    font_size: int = 10,
    bg_color: str = "black",
    fg_color: str = "white",
    padding: int = 10,
) -> bytes:
    """
    Render the ASCII character grid to an SVG image.
    Produces scalable, crisp output using actual text elements.

    Uses textLength + lengthAdjust="spacing" to guarantee every character
    occupies exactly char_w pixels, matching the text preview perfectly.

    Returns:
        SVG document as UTF-8 bytes.
    """
    if not grid or not grid[0]:
        return b""

    rows = len(grid)
    cols = len(grid[0])

    # Monospace character metrics for SVG
    char_w = font_size * 0.6
    line_h = font_size * 1.2

    row_pixel_w = cols * char_w
    svg_w = padding * 2 + row_pixel_w
    svg_h = padding * 2 + rows * line_h

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{svg_w:.1f}" height="{svg_h:.1f}" '
        f'viewBox="0 0 {svg_w:.1f} {svg_h:.1f}">',
        f'<rect width="100%" height="100%" fill="{bg_color}"/>',
    ]

    for r, row in enumerate(grid):
        row_text = "".join(row)
        escaped = html_module.escape(row_text)
        y = padding + (r + 1) * line_h  # SVG text y is baseline
        parts.append(
            f'<text x="{padding}" y="{y:.1f}" '
            f'font-family="\'Courier New\', Courier, monospace" '
            f'font-size="{font_size}" fill="{fg_color}" '
            f'textLength="{row_pixel_w:.1f}" '
            f'lengthAdjust="spacing" '
            f'xml:space="preserve">{escaped}</text>'
        )

    parts.append("</svg>")

    return "\n".join(parts).encode("utf-8")
