from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    service_name: str = "inference"
    log_level: str = "info"
    inference_api_key: str = "dev-shared-secret"


settings = Settings()
