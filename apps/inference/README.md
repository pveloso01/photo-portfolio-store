# inference

Python FastAPI service for face detection + embedding, bib OCR, and quality flags. Called by the Node worker over HTTP.

## Local development

```bash
# from repo root
pnpm py:dev     # runs uvicorn with reload on :8000
pnpm py:test    # runs pytest
pnpm py:lint    # runs ruff check
pnpm py:format  # runs ruff format

# or directly inside apps/inference
uv venv
uv pip install -e ".[dev]"
uv run uvicorn app.main:app --reload
```

## Health check

```
GET /health → { "status": "ok", "service": "inference", "version": "0.1.0" }
```

Real endpoints (`/detect`, `/embed`, `/ocr-bib`, `/quality`) ship in M1.
