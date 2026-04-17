from __future__ import annotations

import json
import mimetypes
import os
import uuid
from typing import Any

from .db import get_db, json_loads_or_empty, row_to_dict, utcnow_iso


class Repo:
    def __init__(self):
        self.db = get_db()

    def list_provider_configs(self) -> list[dict[str, Any]]:
        with self.db.transaction() as conn:
            rows = conn.execute('SELECT * FROM provider_configs ORDER BY is_default DESC, name ASC').fetchall()
            out = []
            for row in rows:
                item = dict(row)
                item['settings'] = json_loads_or_empty(item.pop('settings_json', None))
                item['is_default'] = bool(item['is_default'])
                out.append(item)
            return out

    def get_provider_config(self, provider_config_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as conn:
            row = conn.execute('SELECT * FROM provider_configs WHERE id = ?', (provider_config_id,)).fetchone()
            if not row:
                return None
            item = dict(row)
            item['settings'] = json_loads_or_empty(item.pop('settings_json', None))
            item['is_default'] = bool(item['is_default'])
            return item

    def create_provider_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = utcnow_iso()
        item_id = str(uuid.uuid4())
        with self.db.transaction() as conn:
            if payload.get('is_default'):
                conn.execute('UPDATE provider_configs SET is_default = 0')
            conn.execute(
                '''INSERT INTO provider_configs (id, name, provider, settings_json, is_default, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (
                    item_id,
                    payload['name'],
                    payload['provider'],
                    json.dumps(payload.get('settings', {}), ensure_ascii=False),
                    1 if payload.get('is_default') else 0,
                    now,
                    now,
                ),
            )
        return self.get_provider_config(item_id)  # type: ignore[return-value]

    def list_projects(self) -> list[dict[str, Any]]:
        with self.db.transaction() as conn:
            rows = conn.execute('SELECT * FROM projects ORDER BY name ASC').fetchall()
            return [dict(r) for r in rows]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as conn:
            row = conn.execute('SELECT * FROM projects WHERE id = ?', (project_id,)).fetchone()
            return dict(row) if row else None

    def get_project_by_slug(self, slug: str) -> dict[str, Any] | None:
        with self.db.transaction() as conn:
            row = conn.execute('SELECT * FROM projects WHERE slug = ?', (slug,)).fetchone()
            return dict(row) if row else None

    def create_project(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = utcnow_iso()
        item_id = str(uuid.uuid4())
        storage_prefix = payload.get('storage_prefix') or payload['slug']
        with self.db.transaction() as conn:
            conn.execute(
                '''INSERT INTO projects (id, slug, name, description, provider_config_id, storage_prefix, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (
                    item_id,
                    payload['slug'],
                    payload['name'],
                    payload.get('description', ''),
                    payload['provider_config_id'],
                    storage_prefix,
                    now,
                    now,
                ),
            )
        return self.get_project(item_id)  # type: ignore[return-value]

    def update_project_index_state(self, project_id: str, vector_store_id: str, indexed_at: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                'UPDATE projects SET active_vector_store_id = ?, last_indexed_at = ?, updated_at = ? WHERE id = ?',
                (vector_store_id, indexed_at, indexed_at, project_id),
            )
            conn.execute(
                'UPDATE files SET indexed_at = ?, updated_at = ? WHERE project_id = ?',
                (indexed_at, indexed_at, project_id),
            )

    def list_files(self, project_id: str, category: str | None = None) -> list[dict[str, Any]]:
        with self.db.transaction() as conn:
            if category:
                rows = conn.execute(
                    'SELECT * FROM files WHERE project_id = ? AND category = ? ORDER BY category, relative_path',
                    (project_id, category),
                ).fetchall()
            else:
                rows = conn.execute(
                    'SELECT * FROM files WHERE project_id = ? ORDER BY category, relative_path',
                    (project_id,),
                ).fetchall()
            return [dict(r) for r in rows]

    def get_file(self, file_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as conn:
            row = conn.execute('SELECT * FROM files WHERE id = ?', (file_id,)).fetchone()
            return dict(row) if row else None

    def upsert_file(self, project_id: str, category: str, object_key: str, relative_path: str, size: int, etag: str | None, last_modified: str | None, mime_type: str | None = None, status: str = 'stored') -> dict[str, Any]:
        now = utcnow_iso()
        filename = os.path.basename(relative_path)
        if not mime_type:
            mime_type, _ = mimetypes.guess_type(filename)
        with self.db.transaction() as conn:
            existing = conn.execute(
                'SELECT id, created_at FROM files WHERE project_id = ? AND object_key = ?',
                (project_id, object_key),
            ).fetchone()
            if existing:
                file_id = existing['id']
                created_at = existing['created_at']
                conn.execute(
                    '''UPDATE files SET category = ?, relative_path = ?, filename = ?, mime_type = ?, size = ?, etag = ?, last_modified = ?, status = ?, updated_at = ?
                       WHERE id = ?''',
                    (category, relative_path, filename, mime_type, size, etag, last_modified, status, now, file_id),
                )
            else:
                file_id = str(uuid.uuid4())
                created_at = now
                conn.execute(
                    '''INSERT INTO files (id, project_id, category, object_key, relative_path, filename, mime_type, size, etag, last_modified, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (file_id, project_id, category, object_key, relative_path, filename, mime_type, size, etag, last_modified, status, created_at, now),
                )
            row = conn.execute('SELECT * FROM files WHERE id = ?', (file_id,)).fetchone()
            return dict(row)

    def delete_missing_files(self, project_id: str, current_object_keys: set[str]) -> int:
        with self.db.transaction() as conn:
            rows = conn.execute('SELECT id, object_key FROM files WHERE project_id = ?', (project_id,)).fetchall()
            to_delete = [r['id'] for r in rows if r['object_key'] not in current_object_keys]
            for file_id in to_delete:
                conn.execute('DELETE FROM files WHERE id = ?', (file_id,))
            return len(to_delete)

    def create_reindex_run(self, project_id: str) -> dict[str, Any]:
        now = utcnow_iso()
        run_id = str(uuid.uuid4())
        with self.db.transaction() as conn:
            conn.execute(
                'INSERT INTO reindex_runs (id, project_id, status, started_at) VALUES (?, ?, ?, ?)',
                (run_id, project_id, 'running', now),
            )
            row = conn.execute('SELECT * FROM reindex_runs WHERE id = ?', (run_id,)).fetchone()
            return dict(row)

    def finish_reindex_run(self, run_id: str, status: str, vector_store_id: str | None, uploaded_file_ids: list[str], message: str | None = None) -> dict[str, Any]:
        finished_at = utcnow_iso()
        with self.db.transaction() as conn:
            conn.execute(
                '''UPDATE reindex_runs SET status = ?, vector_store_id = ?, uploaded_file_ids_json = ?, message = ?, finished_at = ? WHERE id = ?''',
                (status, vector_store_id, json.dumps(uploaded_file_ids, ensure_ascii=False), message, finished_at, run_id),
            )
            row = conn.execute('SELECT * FROM reindex_runs WHERE id = ?', (run_id,)).fetchone()
            return dict(row)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as conn:
            row = conn.execute('SELECT * FROM chat_sessions WHERE id = ?', (session_id,)).fetchone()
            return dict(row) if row else None

    def upsert_session(self, session_id: str, project_id: str, last_response_id: str | None) -> None:
        now = utcnow_iso()
        with self.db.transaction() as conn:
            existing = conn.execute('SELECT id FROM chat_sessions WHERE id = ?', (session_id,)).fetchone()
            if existing:
                conn.execute(
                    'UPDATE chat_sessions SET project_id = ?, last_response_id = ?, updated_at = ? WHERE id = ?',
                    (project_id, last_response_id, now, session_id),
                )
            else:
                conn.execute(
                    'INSERT INTO chat_sessions (id, project_id, last_response_id, updated_at) VALUES (?, ?, ?, ?)',
                    (session_id, project_id, last_response_id, now),
                )
