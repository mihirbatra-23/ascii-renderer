"""Flask web server for ASCII art rendering with drag-and-drop upload."""

import base64
import io
import sys
import os

# Add project root to path so ascii_renderer package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, render_template, request, jsonify, send_file

from ascii_renderer.pipeline import AsciiPipeline
from ascii_renderer.config import RendererConfig
from ascii_renderer.gif_renderer import render_gif

_dir = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(_dir, "templates"),
    static_folder=os.path.join(_dir, "static"),
)

# Initialize default pipeline at startup (precomputes character atlas)
_default_pipeline = None


def get_pipeline(config: RendererConfig = None) -> AsciiPipeline:
    """Get or create a pipeline. Reuses the default if config is default."""
    global _default_pipeline
    if config is None:
        if _default_pipeline is None:
            _default_pipeline = AsciiPipeline()
        return _default_pipeline
    return AsciiPipeline(config)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/render", methods=["POST"])
def render_ascii():
    """
    Accept image upload, render ASCII art, return JSON with text + base64 PNG.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    image_bytes = file.read()
    max_width = int(request.form.get("max_width", 120))
    global_contrast = float(request.form.get("global_contrast", 2.0))
    dir_contrast = float(request.form.get("directional_contrast", 3.0))

    config = RendererConfig(
        global_contrast_exponent=global_contrast,
        directional_contrast_exponent=dir_contrast,
    )
    pipeline = get_pipeline(config)

    try:
        result = pipeline.render(image_bytes=image_bytes, max_width=max_width)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    png_b64 = base64.b64encode(result["png_bytes"]).decode("ascii")
    svg_b64 = base64.b64encode(result["svg_bytes"]).decode("ascii")

    return jsonify({
        "text": result["text"],
        "image_base64": png_b64,
        "svg_base64": svg_b64,
        "rows": result["rows"],
        "cols": result["cols"],
        "cache_stats": result["cache_stats"],
    })


@app.route("/render-gif", methods=["POST"])
def render_gif_endpoint():
    """
    Accept GIF upload, render each frame to ASCII, return animated GIF.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    gif_bytes = file.read()
    max_width = int(request.form.get("max_width", 120))
    global_contrast = float(request.form.get("global_contrast", 2.0))
    dir_contrast = float(request.form.get("directional_contrast", 3.0))

    config = RendererConfig(
        global_contrast_exponent=global_contrast,
        directional_contrast_exponent=dir_contrast,
    )
    pipeline = get_pipeline(config)

    try:
        result = render_gif(
            gif_bytes=gif_bytes,
            pipeline=pipeline,
            max_width=max_width,
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    gif_b64 = base64.b64encode(result["gif_bytes"]).decode("ascii")

    return jsonify({
        "gif_base64": gif_b64,
        "frame_count": result["frame_count"],
        "text": result["text"],
    })


@app.route("/download", methods=["POST"])
def download_png():
    """Render and return the PNG directly as a file download."""
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    image_bytes = file.read()
    max_width = int(request.form.get("max_width", 120))

    pipeline = get_pipeline()
    result = pipeline.render(image_bytes=image_bytes, max_width=max_width)

    return send_file(
        io.BytesIO(result["png_bytes"]),
        mimetype="image/png",
        as_attachment=True,
        download_name="ascii_art.png",
    )


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=8080)
