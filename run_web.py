"""Launch the ASCII renderer web server."""
import os
import sys

# Ensure project root is on sys.path and cwd is correct
project_root = os.path.dirname(os.path.abspath(__file__))
os.chdir(project_root)
sys.path.insert(0, project_root)

from web.app import app

if __name__ == "__main__":
    print("Starting ASCII Renderer web UI at http://localhost:8080")
    print("Open your browser to: http://localhost:8080")
    app.run(debug=True, host="127.0.0.1", port=8080)
