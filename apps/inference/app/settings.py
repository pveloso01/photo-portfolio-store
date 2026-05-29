from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    service_name: str = "inference"
    log_level: str = "info"
    inference_api_key: str = "dev-shared-secret"
    # F3.12 — EAR threshold below which an eye is considered closed. Env-tunable
    # (INFERENCE_EYES_CLOSED_EAR_THRESHOLD); never hardcoded in route logic.
    eyes_closed_ear_threshold: float = 0.21


settings = Settings()
