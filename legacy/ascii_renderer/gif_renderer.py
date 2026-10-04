"""Render animated GIFs to ASCII art GIFs."""

import io
from PIL import Image

from .pipeline import AsciiPipeline


def render_gif(
    gif_bytes: bytes,
    pipeline: AsciiPipeline,
    max_width: int = 120,
    max_frames: int = 60,
) -> dict:
    """
    Render an animated GIF into an ASCII art animated GIF.

    Each frame of the input GIF is rendered to ASCII via the pipeline,
    then the resulting PNG frames are reassembled into an animated GIF.

    Args:
        gif_bytes: Raw bytes of the input GIF.
        pipeline: An AsciiPipeline instance (reused across frames for cache).
        max_width: Maximum character columns per frame.
        max_frames: Cap on number of frames to process.

    Returns:
        dict with keys:
            gif_bytes: The animated ASCII GIF as bytes.
            frame_count: Number of frames rendered.
            text: ASCII text of the first frame.
    """
    src = Image.open(io.BytesIO(gif_bytes))

    n_frames = min(getattr(src, "n_frames", 1), max_frames)
    durations = []
    ascii_frames = []
    first_frame_text = ""

    for i in range(n_frames):
        src.seek(i)

        # Get per-frame duration (milliseconds), default 100ms
        duration = src.info.get("duration", 100)
        if duration <= 0:
            duration = 100
        durations.append(duration)

        # Convert frame to RGB PNG bytes for the pipeline
        frame_rgb = src.convert("RGB")
        buf = io.BytesIO()
        frame_rgb.save(buf, format="PNG")
        frame_png_bytes = buf.getvalue()

        # Render through the ASCII pipeline
        result = pipeline.render(image_bytes=frame_png_bytes, max_width=max_width)

        # Collect the rendered PNG as a PIL Image
        ascii_img = Image.open(io.BytesIO(result["png_bytes"]))
        ascii_frames.append(ascii_img)

        if i == 0:
            first_frame_text = result["text"]

    if not ascii_frames:
        return {"gif_bytes": b"", "frame_count": 0, "text": ""}

    # Assemble animated GIF
    # Convert all frames to "P" (palette) mode for GIF compatibility
    gif_frames = []
    for frame in ascii_frames:
        # Convert to RGB first (ensure consistency), then to palette
        rgb_frame = frame.convert("RGB")
        gif_frames.append(rgb_frame)

    output = io.BytesIO()
    gif_frames[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=gif_frames[1:] if len(gif_frames) > 1 else [],
        duration=durations,
        loop=0,
    )

    return {
        "gif_bytes": output.getvalue(),
        "frame_count": n_frames,
        "text": first_frame_text,
    }
