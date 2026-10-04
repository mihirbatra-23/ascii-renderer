# Legacy Python renderer

The original Python/Flask implementation, kept for reference. It is superseded by the browser app in the repository root.

```bash
cd legacy
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py test_image.png -w 80        # CLI
.venv/bin/python run_web.py                         # Flask UI on http://127.0.0.1:8080
```
