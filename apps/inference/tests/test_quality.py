"""Tests for the F3.12 eyes-closed quality route + EAR math."""

from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.lib.eye_aspect_ratio import (
    DEFAULT_EAR_THRESHOLD,
    eye_aspect_ratio,
    eyes_closed_for_landmarks,
)
from app.lib.face_model import MODEL_NAME
from app.main import app
from app.settings import settings

client = TestClient(app)


def _auth_headers() -> dict[str, str]:
    return {"X-API-Key": settings.inference_api_key}


def _png_bytes(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def _model_pack_present() -> bool:
    if importlib.util.find_spec("insightface") is None:
        return False
    pack_dir = Path(os.path.expanduser("~/.insightface/models")) / MODEL_NAME
    return pack_dir.is_dir()


_skip_no_model = pytest.mark.skipif(
    not _model_pack_present(),
    reason="InsightFace model pack not available locally",
)


# ---------- EAR math (pure, always runs) ----------


def _open_eye_points() -> list[tuple[float, float]]:
    # Wide-open eye: corners 20px apart, lids 8px apart -> EAR ~0.4.
    # p1 outer corner, p2/p3 upper, p4 inner corner, p5/p6 lower.
    return [(0, 0), (5, 4), (15, 4), (20, 0), (15, -4), (5, -4)]


def _closed_eye_points() -> list[tuple[float, float]]:
    # Closed eye: lids nearly touching -> EAR ~0.
    return [(0, 0), (5, 0.2), (15, 0.2), (20, 0), (15, -0.2), (5, -0.2)]


def test_open_eye_ear_above_threshold() -> None:
    ear = eye_aspect_ratio(_open_eye_points())
    assert ear > DEFAULT_EAR_THRESHOLD


def test_closed_eye_ear_below_threshold() -> None:
    ear = eye_aspect_ratio(_closed_eye_points())
    assert ear < DEFAULT_EAR_THRESHOLD


def test_eye_aspect_ratio_degenerate_width_returns_zero() -> None:
    pts = [(0, 0), (0, 4), (0, 4), (0, 0), (0, -4), (0, -4)]
    assert eye_aspect_ratio(pts) == 0.0


def test_eye_aspect_ratio_requires_six_points() -> None:
    with pytest.raises(ValueError):
        eye_aspect_ratio([(0, 0), (1, 1)])


def test_eyes_closed_for_landmarks_flags_only_when_both_closed() -> None:
    # Build a 106-point array; closed left + closed right -> closed=True.
    needed = 97
    closed = _closed_eye_points()
    open_ = _open_eye_points()
    from app.lib.eye_aspect_ratio import LEFT_EYE_EAR_IDX, RIGHT_EYE_EAR_IDX

    landmarks: list[tuple[float, float]] = [(0.0, 0.0)] * needed
    for slot, pt in zip(LEFT_EYE_EAR_IDX, closed, strict=True):
        landmarks[slot] = pt
    for slot, pt in zip(RIGHT_EYE_EAR_IDX, closed, strict=True):
        landmarks[slot] = pt
    is_closed, _, _ = eyes_closed_for_landmarks(landmarks)
    assert is_closed is True

    # Open one eye -> not flagged.
    for slot, pt in zip(RIGHT_EYE_EAR_IDX, open_, strict=True):
        landmarks[slot] = pt
    is_closed_one_open, _, _ = eyes_closed_for_landmarks(landmarks)
    assert is_closed_one_open is False


def test_eyes_closed_for_landmarks_rejects_short_array() -> None:
    with pytest.raises(ValueError):
        eyes_closed_for_landmarks([(0, 0)] * 10)


# ---------- Route validation (no model needed) ----------


def test_quality_requires_api_key() -> None:
    files = {"image": ("x.png", io.BytesIO(_png_bytes(64, 64)), "image/png")}
    response = client.post("/quality/", files=files)
    assert response.status_code == 401


def test_quality_rejects_huge_image() -> None:
    files = {"image": ("huge.png", io.BytesIO(_png_bytes(8000, 8000)), "image/png")}
    response = client.post("/quality/", files=files, headers=_auth_headers())
    assert response.status_code == 413


def test_quality_rejects_corrupt_image() -> None:
    files = {"image": ("garbage.bin", io.BytesIO(b"\x00not-an-image\xff"), "image/png")}
    response = client.post("/quality/", files=files, headers=_auth_headers())
    assert response.status_code == 422


# ---------- Route happy path (model-gated) ----------


@_skip_no_model
def test_quality_returns_shape() -> None:
    files = {"image": ("blank.png", io.BytesIO(_png_bytes(640, 480)), "image/png")}
    response = client.post("/quality/", files=files, headers=_auth_headers())
    assert response.status_code == 200
    body = response.json()
    assert "faces" in body
    assert "eyes_closed_faces" in body
    assert body["ear_threshold"] == settings.eyes_closed_ear_threshold
    assert isinstance(body["faces_detail"], list)
