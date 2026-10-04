"""Generate the procedural sample media shipped with the app (public/samples/).

Everything here is synthesised from maths, so the samples carry no third-party rights.
Run: python3 scripts/make_samples.py  (needs numpy + Pillow; the video also needs ffmpeg on PATH or FFMPEG=...)
     python3 scripts/make_samples.py --thumbs   only the start-screen thumbnail sources (public/samples/thumbs/)

The start screen renders its sample tiles from small copies (THUMB_W wide, the 72-column tile's
analysis width), so a first visit downloads ~40 KB instead of the full samples and the video.
"""
import os, subprocess, sys
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "samples")
THUMBS = os.path.join(OUT, "thumbs")
W, H = 1280, 720
# 72 columns × 8 px: the width the start-screen tiles analyse (src/ui/start/thumbs.ts).
THUMB_W = 576
# The video tile shows frame 34 of 96 (also its look in src/ui/start/samples.ts).
POSTER_FRAME = 34


def save(a, name):
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).save(os.path.join(OUT, name), optimize=True)


def normalize(v):
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)


def raymarch(sdf, ro, rd, steps=96):
    t = np.zeros(rd.shape[:2], np.float32)
    hit = np.zeros(rd.shape[:2], bool)
    for _ in range(steps):
        d = sdf(ro + rd * t[..., None])
        hit |= d < 1e-3
        t = np.minimum(t + np.where(hit, 0, d), 50.0)  # cap missed rays so they never overflow
    p = ro + rd * t[..., None]
    e = 1e-3
    n = normalize(np.stack([sdf(p + [e, 0, 0]) - sdf(p - [e, 0, 0]),
                            sdf(p + [0, e, 0]) - sdf(p - [0, e, 0]),
                            sdf(p + [0, 0, e]) - sdf(p - [0, 0, e])], -1))
    return hit, p, n


def camera(eye_y=0.6, dist=3.2, fov=1.8):
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    u = (xs - W / 2) / (H / 2)
    v = -(ys - H / 2) / (H / 2)
    rd = normalize(np.stack([u, v - 0.18, -np.full_like(u, fov)], -1))
    return np.array([0, eye_y, dist], np.float32), rd


def shade(hit, n, rd, light=(-0.6, 0.8, 0.5), spec_pow=40):
    L = normalize(np.array(light, np.float32))
    diff = np.clip((n * L).sum(-1), 0, 1)
    h = normalize(L - rd)
    spec = np.clip((n * h).sum(-1), 0, 1) ** spec_pow
    rim = (1 - np.clip(-(n * rd).sum(-1), 0, 1)) ** 3
    return np.where(hit, 0.06 + 0.78 * diff + 0.55 * spec + 0.22 * rim, 0.0)


def torus():
    """The hero sample: a tilted, spun torus with a lifted ambient term so the shadow side keeps detail."""
    tilt, spin = 0.92, 0.38

    def rot(p):
        c, s = np.cos(tilt), np.sin(tilt)
        x, y, z = p[..., 0], p[..., 1] * c - p[..., 2] * s, p[..., 1] * s + p[..., 2] * c
        c2, s2 = np.cos(spin), np.sin(spin)
        return np.stack([x * c2 + y * s2, -x * s2 + y * c2, z], -1)

    def sdf(p):
        q = rot(p)
        ring = np.sqrt(q[..., 0] ** 2 + q[..., 2] ** 2) - 1.0
        return np.sqrt(ring ** 2 + q[..., 1] ** 2) - 0.40

    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    u = (xs - W / 2) / (H / 2)
    v = -(ys - H / 2) / (H / 2)
    rd = normalize(np.stack([u, v - 0.17, -np.full_like(u, 1.75)], -1))
    ro = np.array([0, 0.5, 2.75], np.float32)
    hit, _, n = raymarch(sdf, ro, rd)
    L = normalize(np.array([-0.6, 0.8, 0.55], np.float32))
    diff = np.clip((n * L).sum(-1), 0, 1)
    spec = np.clip((n * normalize(L - rd)).sum(-1), 0, 1) ** 40
    rim = (1 - np.clip(-(n * rd).sum(-1), 0, 1)) ** 3
    save(np.where(hit, 0.16 + 0.70 * diff + 0.55 * spec + 0.30 * rim, 0.0), "torus.png")


def planet():
    ro, rd = camera(eye_y=0.0, dist=3.0, fov=1.6)
    def sdf(p):
        return np.linalg.norm(p - np.array([0.25, 0.2, 0]), axis=-1) - 0.95
    hit, p, n = raymarch(sdf, ro, rd)
    q = p - np.array([0.25, 0.2, 0])
    bands = 0.5 + 0.5 * np.sin(q[..., 1] * 9 + np.sin(q[..., 0] * 3) * 1.5)
    base = shade(hit, n, rd, light=(-0.8, 0.4, 0.6), spec_pow=20) * (0.7 + 0.3 * bands)
    # ring: thin tilted annulus in front of / behind the sphere
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    cx, cy = W / 2 + 0.25 * H / 2 / 1.6 * 2.2, H / 2 - 0.2 * H / 2 / 1.6 * 2.2
    dx, dy = (xs - cx), (ys - cy) * 3.2
    r = np.sqrt(dx ** 2 + dy ** 2) / (H * 0.62)
    ring = ((r > 0.78) & (r < 1.0)) * (0.55 + 0.25 * np.sin(r * 90))
    behind = (dy < 0) & hit
    img = np.where(behind, base, np.maximum(base, ring))
    rng = np.random.default_rng(3)
    stars = (rng.random((H, W)) > 0.9985) * rng.uniform(0.3, 1.0, (H, W))
    save(np.where(hit | (ring > 0), img, stars), "planet.png")


def interference_frames(n=96):
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    for i in range(n):
        t = i / n * 2 * np.pi
        a = (np.sin(np.hypot(xs - 420 - 80 * np.cos(t), ys - 360 - 60 * np.sin(t)) * 0.045 - t * 2)
             + np.sin(np.hypot(xs - 860 + 80 * np.cos(t), ys - 360 + 60 * np.sin(t)) * 0.04 - t * 2))
        env = np.exp(-((xs - 640) ** 2 / (2 * 470 ** 2) + (ys - 360) ** 2 / (2 * 300 ** 2)))
        yield ((a + 2) / 4 * env) ** 0.9


def save_thumb(img, name):
    """A THUMB_W-wide copy of a sample (or of the video's poster frame) for the start screen. Smooth
    gradients go to JPEG (a third of the PNG size; the tile reads tone only, so artefacts don't show)."""
    os.makedirs(THUMBS, exist_ok=True)
    w, h = img.size
    small = img.resize((THUMB_W, round(THUMB_W * h / w)), Image.LANCZOS)
    small.save(os.path.join(THUMBS, name), **({"quality": 88} if name.endswith(".jpg") else {"optimize": True}))


def thumbs():
    for name in ("torus.png", "planet.png"):
        save_thumb(Image.open(os.path.join(OUT, name)).convert("L"), name)
    for i, f in enumerate(interference_frames()):
        if i == POSTER_FRAME:
            save_thumb(Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8)), "interference_loop.jpg")
            break


def interference_video():
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
    out = os.path.join(OUT, "interference_loop.mp4")
    proc = subprocess.Popen([ffmpeg, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
                             "-s", f"{W}x{H}", "-r", "24", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                             "-crf", "26", "-movflags", "+faststart", out], stdin=subprocess.PIPE)
    for f in interference_frames():
        proc.stdin.write((np.clip(f, 0, 1) * 255).astype(np.uint8).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    if "--thumbs" not in sys.argv:
        torus()
        planet()
        interference_video()
    thumbs()
    print("samples written to", os.path.abspath(OUT))
