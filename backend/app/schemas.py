from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


class ProviderConfigCreate(BaseModel):
    name: str
    provider: Literal['yandex'] = 'yandex'
    settings: dict[str, Any] = Field(default_factory=dict)
    is_default: bool = False


class ProviderConfigOut(BaseModel):
    id: str
    name: str
    provider: str
    settings: dict[str, Any]
    is_default: bool
    created_at: str
    updated_at: str


class ProjectCreate(BaseModel):
    name: str
    slug: str
    description: str = ''
    provider_config_id: str
    storage_prefix: str | None = None


class ProjectOut(BaseModel):
    id: str
    slug: str
    name: str
    description: str | None = None
    provider_config_id: str
    storage_prefix: str
    active_vector_store_id: str | None = None
    last_indexed_at: str | None = None
    created_at: str
    updated_at: str


class FileOut(BaseModel):
    id: str
    project_id: str
    category: str
    object_key: str
    relative_path: str
    filename: str
    mime_type: str | None = None
    size: int
    etag: str | None = None
    last_modified: str | None = None
    indexed_at: str | None = None
    status: str
    created_at: str
    updated_at: str


class QueryRequest(BaseModel):
    question: str
    session_id: str | None = None
    editor_context: str | None = None


class SourceRef(BaseModel):
    file: str | None = None
    quote: str | None = None
    page: int | None = None
    line: str | None = None


class QueryResponse(BaseModel):
    answer: str
    sources: list[SourceRef] = Field(default_factory=list)
    raw_text: str = ''
    response_id: str | None = None


class ReindexResult(BaseModel):
    project_id: str
    vector_store_id: str
    uploaded_files: int
    run_id: str
    started_at: str
    finished_at: str


class SyncResult(BaseModel):
    project_id: str
    total_files: int
    created_or_updated: int
    deleted: int


class HealthOut(BaseModel):
    status: str
    app_name: str
