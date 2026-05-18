import os

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration


def init_sentry() -> None:
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return
    sentry_sdk.init(
        dsn=dsn,
        release=os.getenv("SENTRY_RELEASE"),
        environment=os.getenv("NODE_ENV", "development"),
        traces_sample_rate=0.1 if os.getenv("NODE_ENV") == "production" else 1.0,
        send_default_pii=False,
        integrations=[FastApiIntegration()],
    )
