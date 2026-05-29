"""Eye-aspect-ratio (EAR) primitives for eyes-closed detection (F3.12).

The EAR metric (Soukupová & Čech, 2016) is the ratio of the eye's vertical
opening to its horizontal width. It drops sharply toward zero when an eye
closes and is stable (~0.25-0.35) when open, independent of face scale.

The pure math lives in :func:`eye_aspect_ratio` and is fully unit-tested on
synthetic coordinates. :func:`eyes_closed_for_landmarks` maps InsightFace's
106-point landmark array onto the 6 EAR points per eye and returns whether the
face's eyes are closed at the given threshold.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

Point = Sequence[float]

# Default EAR threshold. Below this, an eye is considered closed. 0.21 is the
# widely-cited operating point for the 6-point EAR; exposed via settings so it
# is never hardcoded in business logic.
DEFAULT_EAR_THRESHOLD = 0.21

# 6-point EAR landmark indices into InsightFace's 106-point 2d106 model, ordered
# (p1..p6) following the dlib EAR convention:
#   p1 = outer (horizontal) corner
#   p2, p3 = upper-lid points
#   p4 = inner (horizontal) corner
#   p5, p6 = lower-lid points
# EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
# Index sets follow the published insightface 2d106 eye-contour layout; they are
# constants (not business logic) and can be recalibrated against the model pack.
LEFT_EYE_EAR_IDX: tuple[int, int, int, int, int, int] = (35, 36, 33, 39, 42, 40)
RIGHT_EYE_EAR_IDX: tuple[int, int, int, int, int, int] = (89, 90, 87, 93, 96, 94)


def _dist(a: Point, b: Point) -> float:
    return math.hypot(float(a[0]) - float(b[0]), float(a[1]) - float(b[1]))


def eye_aspect_ratio(points: Sequence[Point]) -> float:
    """Compute the eye-aspect-ratio from 6 ordered eye landmarks.

    Args:
        points: exactly 6 (x, y) points ordered (p1..p6) per the dlib EAR
            convention (two horizontal corners + two upper-lid + two lower-lid).

    Returns:
        The EAR value. Returns 0.0 when the horizontal span is degenerate
        (zero width), which conservatively reads as "closed".

    Raises:
        ValueError: if fewer than 6 points are supplied.
    """
    if len(points) < 6:
        raise ValueError(f"eye_aspect_ratio expects 6 points, got {len(points)}")
    p1, p2, p3, p4, p5, p6 = points[:6]
    horizontal = _dist(p1, p4)
    if horizontal == 0:
        return 0.0
    vertical = _dist(p2, p6) + _dist(p3, p5)
    return vertical / (2.0 * horizontal)


def _select(landmarks: Sequence[Point], idx: tuple[int, ...]) -> list[Point]:
    return [landmarks[i] for i in idx]


def eyes_closed_for_landmarks(
    landmarks: Sequence[Point],
    threshold: float = DEFAULT_EAR_THRESHOLD,
) -> tuple[bool, float, float]:
    """Decide whether a face's eyes are closed from its 106-point landmarks.

    A face counts as eyes-closed only when BOTH eyes are below the threshold —
    a single closed eye (wink / blink artifact) is not flagged.

    Args:
        landmarks: the 106-point 2d106 landmark array (each item an (x, y) pair).
        threshold: EAR below which an eye is considered closed.

    Returns:
        ``(closed, left_ear, right_ear)``.

    Raises:
        ValueError: if the landmark array is too short for the 106-point model.
    """
    needed = max(*LEFT_EYE_EAR_IDX, *RIGHT_EYE_EAR_IDX) + 1
    if len(landmarks) < needed:
        raise ValueError(
            f"eyes_closed_for_landmarks expects >= {needed} landmarks, got {len(landmarks)}"
        )
    left_ear = eye_aspect_ratio(_select(landmarks, LEFT_EYE_EAR_IDX))
    right_ear = eye_aspect_ratio(_select(landmarks, RIGHT_EYE_EAR_IDX))
    closed = left_ear < threshold and right_ear < threshold
    return closed, left_ear, right_ear
