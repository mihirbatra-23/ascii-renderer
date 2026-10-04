"""CLI entry point for ASCII art rendering."""

import argparse
import sys

from ascii_renderer.pipeline import AsciiPipeline
from ascii_renderer.config import RendererConfig


def main():
    parser = argparse.ArgumentParser(description="High-quality ASCII art renderer")
    parser.add_argument("image", help="Path to input image")
    parser.add_argument("-w", "--width", type=int, default=120, help="Output width in characters (default: 120)")
    parser.add_argument("-o", "--output", help="Output PNG path (optional)")
    parser.add_argument("--global-contrast", type=float, default=2.0, help="Global contrast exponent (default: 2.0)")
    parser.add_argument("--dir-contrast", type=float, default=3.0, help="Directional contrast exponent (default: 3.0)")
    parser.add_argument("--font-size", type=int, default=10, help="Output PNG font size (default: 10)")
    args = parser.parse_args()

    config = RendererConfig(
        global_contrast_exponent=args.global_contrast,
        directional_contrast_exponent=args.dir_contrast,
        output_font_size=args.font_size,
    )

    pipeline = AsciiPipeline(config)
    result = pipeline.render(image_path=args.image, max_width=args.width)

    print(result["text"])

    if args.output:
        with open(args.output, "wb") as f:
            f.write(result["png_bytes"])
        print(f"\nPNG saved to: {args.output}", file=sys.stderr)

    stats = result["cache_stats"]
    print(
        f"\n[{result['cols']}x{result['rows']} grid, "
        f"cache hit rate: {stats['hit_rate']:.1%}]",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
