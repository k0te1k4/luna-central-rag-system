from __future__ import annotations

from functools import lru_cache
from pydantic import BaseModel, Field
import os


class Settings(BaseModel):
    app_name: str = Field(default=os.getenv('APP_NAME', 'LuNA RAG Backend'))
    app_host: str = Field(default=os.getenv('APP_HOST', '0.0.0.0'))
    app_port: int = Field(default=int(os.getenv('APP_PORT', '8000')))
    public_base_url: str = Field(default=os.getenv('PUBLIC_BASE_URL', 'http://localhost:8000'))
    data_dir: str = Field(default=os.getenv('LUNA_DATA_DIR', '/data'))
    db_path: str = Field(default=os.getenv('LUNA_DB_PATH', '/data/luna.db'))

    default_yandex_api_key: str = Field(default=os.getenv('YANDEX_API_KEY', ''))
    default_s3_access_key: str = Field(default=os.getenv('YANDEX_S3_ACCESS_KEY', ''))
    default_s3_secret_key: str = Field(default=os.getenv('YANDEX_S3_SECRET_KEY', ''))

    default_storage_endpoint: str = Field(default=os.getenv('YANDEX_S3_ENDPOINT', 'https://storage.yandexcloud.net'))
    default_storage_region: str = Field(default=os.getenv('YANDEX_S3_REGION', 'ru-central1'))
    default_bucket: str = Field(default=os.getenv('YANDEX_S3_BUCKET', ''))
    default_base_prefix: str = Field(default=os.getenv('YANDEX_STORAGE_BASE_PREFIX', 'luna-kb'))
    default_folder_id: str = Field(default=os.getenv('YANDEX_FOLDER_ID', ''))
    default_generation_model: str = Field(default=os.getenv('YANDEX_GENERATION_MODEL', ''))
    default_vector_store_prefix: str = Field(default=os.getenv('YANDEX_VECTOR_STORE_PREFIX', 'luna-kb'))
    default_vector_store_ttl_days: int = Field(default=int(os.getenv('YANDEX_VECTOR_STORE_TTL_DAYS', '365')))
    default_search_max_results: int = Field(default=int(os.getenv('YANDEX_SEARCH_MAX_RESULTS', '6')))
    default_chunk_max_tokens: int = Field(default=int(os.getenv('YANDEX_CHUNK_MAX_TOKENS', '0')))
    default_chunk_overlap_tokens: int = Field(default=int(os.getenv('YANDEX_CHUNK_OVERLAP_TOKENS', '0')))

    default_api_key_env_name: str = Field(default=os.getenv('YANDEX_API_KEY_ENV_NAME', 'YANDEX_API_KEY'))
    default_s3_access_env_name: str = Field(default=os.getenv('YANDEX_S3_ACCESS_KEY_ENV_NAME', 'YANDEX_S3_ACCESS_KEY'))
    default_s3_secret_env_name: str = Field(default=os.getenv('YANDEX_S3_SECRET_KEY_ENV_NAME', 'YANDEX_S3_SECRET_KEY'))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
