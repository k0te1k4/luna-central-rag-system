from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from .config import get_settings


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Database:
    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._lock = threading.Lock()
        self._initialized = False

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        return conn

    @contextmanager
    def transaction(self):
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init(self) -> None:
        with self._lock:
            if self._initialized:
                return
            with self.transaction() as conn:
                conn.executescript(
                    '''
                    CREATE TABLE IF NOT EXISTS provider_configs (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        settings_json TEXT NOT NULL,
                        is_default INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS projects (
                        id TEXT PRIMARY KEY,
                        slug TEXT NOT NULL UNIQUE,
                        name TEXT NOT NULL,
                        description TEXT,
                        provider_config_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE RESTRICT,
                        storage_prefix TEXT NOT NULL,
                        active_vector_store_id TEXT,
                        last_indexed_at TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS files (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        category TEXT NOT NULL,
                        object_key TEXT NOT NULL,
                        relative_path TEXT NOT NULL,
                        filename TEXT NOT NULL,
                        mime_type TEXT,
                        size INTEGER NOT NULL DEFAULT 0,
                        etag TEXT,
                        last_modified TEXT,
                        indexed_at TEXT,
                        status TEXT NOT NULL DEFAULT 'stored',
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        UNIQUE(project_id, object_key)
                    );

                    CREATE TABLE IF NOT EXISTS reindex_runs (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        status TEXT NOT NULL,
                        vector_store_id TEXT,
                        uploaded_file_ids_json TEXT,
                        message TEXT,
                        started_at TEXT NOT NULL,
                        finished_at TEXT
                    );

                    CREATE TABLE IF NOT EXISTS chat_sessions (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                        last_response_id TEXT,
                        updated_at TEXT NOT NULL
                    );
                    '''
                )
            self._initialized = True
            self.ensure_default_provider()

    def ensure_default_provider(self) -> None:
        settings = get_settings()
        now = utcnow_iso()
        default_settings = {
            'folder_id': settings.default_folder_id,
            'bucket': settings.default_bucket,
            'endpoint': settings.default_storage_endpoint,
            'region': settings.default_storage_region,
            'base_prefix': settings.default_base_prefix,
            'generation_model': settings.default_generation_model,
            'vector_store_name_prefix': settings.default_vector_store_prefix,
            'vector_store_ttl_days': settings.default_vector_store_ttl_days,
            'search_max_results': settings.default_search_max_results,
            'chunk_max_tokens': settings.default_chunk_max_tokens,
            'chunk_overlap_tokens': settings.default_chunk_overlap_tokens,
            'api_key_env_name': settings.default_api_key_env_name,
            's3_access_key_env_name': settings.default_s3_access_env_name,
            's3_secret_key_env_name': settings.default_s3_secret_env_name,
        }
        with self.transaction() as conn:
            row = conn.execute('SELECT id FROM provider_configs WHERE is_default = 1 LIMIT 1').fetchone()
            if row:
                return
            conn.execute(
                '''INSERT INTO provider_configs (id, name, provider, settings_json, is_default, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 1, ?, ?)''',
                (str(uuid.uuid4()), 'Default Yandex Provider', 'yandex', json.dumps(default_settings, ensure_ascii=False), now, now),
            )


_db: Database | None = None


def get_db() -> Database:
    global _db
    if _db is None:
        _db = Database(get_settings().db_path)
        _db.init()
    return _db


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def json_loads_or_empty(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    return json.loads(value)
