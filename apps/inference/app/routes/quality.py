"""Eyes-closed quality scoring route (F3.12).

Detects faces with InsightFace and computes the eye-aspect-ratio per face from
the 106-point landmarks. Returns per-face EAR plus an aggregate ``eyes_closed``
count. Blur and near-duplicate detection live in the worker (JS, no model
needed); this endpoint owns only the landmark-dependent signal.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.auth import require_api_key
from app.lib.eye_aspect_ratio import eyes_closed_for_landmarks
from app.lib.face_model import get_model, model_version
from app.lib.image import ImageDecodeError, ImageTooLarge, decode_image
from app.settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/quality",
    tags=["inference"],
    dependencies=[Depends(require_api_key)],
)

MAX_UPLOAD_BYTES = 16 * 1024 * 1024  # 16 MiB


class FaceQuality(BaseModel):
    """Per-face eyes-closed assessment."""

    bbox: list[float] = Field(
        ...,
        description="Bounding box in pixel coordinates as [x, y, width, height].",
        min_length=4,
        max_length=4,
    )
    eyes_closed: bool = Field(..., description="True when both eyes are below the EAR threshold.")
    left_ear: float = Field(..., description="Eye-aspect-ratio of the left eye.")
    right_ear: float = Field(..., description="Eye-aspect-ratio of the right eye.")


class QualityResponse(BaseModel):
    """Response payload for ``POST /quality/``."""

    faces: int = Field(..., description="Number of faces detected.")
    eyes_closed_faces: int = Field(..., description="How many detected faces have closed eyes.")
    ear_threshold: float = Field(..., description="The EAR threshold applied.")
    faces_detail: list[FaceQuality]
    model_version: str


def _bbox_xywh(raw: object) -> list[float]:
    x1, y1, x2, y2 = (float(v) for v in raw)  # type: ignore[misc]
    return [x1, y1, x2 - x1, y2 - y1]


def _landmarks_2d_106(face: object) -> list[list[float]] | None:
    raw = getattr(face, "landmark_2d_106", None)
    if raw is None:
        return None
    return [[float(v) for v in point] for point in raw]  # type: ignore[union-attr]


@router.post("/", response_model=QualityResponse)
async def quality(image: UploadFile) -> QualityResponse:
    """Score eyes-closed quality signals for an uploaded image."""
    raw = await image.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        logger.warning("quality rejected oversized upload bytes=%d", len(raw))
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"upload exceeds {MAX_UPLOAD_BYTES} bytes",
        )

    try:
        bgr = decode_image(raw)
    except ImageTooLarge as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except ImageDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    try:
        model = get_model()
    except RuntimeError as exc:
        logger.error("quality failed: model unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="face model not ready",
        ) from exc

    threshold = settings.eyes_closed_ear_threshold
    raw_faces = model.get(bgr)
    detail: list[FaceQuality] = []
    for face in raw_faces:
        landmarks = _landmarks_2d_106(face)
        if landmarks is None:
            # No 106-point landmarks available for this face; cannot assess.
            logger.warning("quality skipping face without 2d106 landmarks")
            continue
        try:
            closed, left_ear, right_ear = eyes_closed_for_landmarks(landmarks, threshold)
        except ValueError:
            logger.warning("quality skipping face with insufficient landmarks")
            continue
        detail.append(
            FaceQuality(
                bbox=_bbox_xywh(face.bbox),
                eyes_closed=closed,
                left_ear=left_ear,
                right_ear=right_ear,
            )
        )

    eyes_closed_faces = sum(1 for f in detail if f.eyes_closed)
    logger.info(
        "quality filename=%s faces=%d eyes_closed=%d",
        image.filename,
        len(detail),
        eyes_closed_faces,
    )
    return QualityResponse(
        faces=len(detail),
        eyes_closed_faces=eyes_closed_faces,
        ear_threshold=threshold,
        faces_detail=detail,
        model_version=model_version(),
    )
