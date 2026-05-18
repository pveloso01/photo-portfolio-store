from fastapi import FastAPI

from app import __version__
from app.settings import settings

app = FastAPI(title=settings.service_name, version=__version__)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": settings.service_name, "version": __version__}
