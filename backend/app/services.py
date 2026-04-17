from __future__ import annotations

import mimetypes
import os
from typing import Any

from .config import get_settings
from .repository import Repo
from .db import utcnow_iso
from .yandex_client import (
    ResolvedProvider,
    YandexAIStudioClient,
    YandexApiError,
    YandexStorageClient,
    extract_answer_and_sources,
    wait_until_batch_ready,
    wait_until_vector_store_ready,
)


class ProjectService:
    def __init__(self):
        self.repo = Repo()
        self.settings = get_settings()

    def resolve_provider(self, provider_config_id: str) -> ResolvedProvider:
        provider_config = self.repo.get_provider_config(provider_config_id)
        if not provider_config:
            raise ValueError('Provider config not found')
        settings = provider_config['settings']
        api_key_env = settings.get('api_key_env_name') or self.settings.default_api_key_env_name
        s3_access_env = settings.get('s3_access_key_env_name') or self.settings.default_s3_access_env_name
        s3_secret_env = settings.get('s3_secret_key_env_name') or self.settings.default_s3_secret_env_name
        api_key = os.getenv(api_key_env, self.settings.default_yandex_api_key)
        s3_access_key = os.getenv(s3_access_env, self.settings.default_s3_access_key)
        s3_secret_key = os.getenv(s3_secret_env, self.settings.default_s3_secret_key)
        if provider_config['provider'] != 'yandex':
            raise ValueError('Only yandex provider is supported in the first stage')
        if not api_key:
            raise ValueError(f'Missing Yandex API key in env var {api_key_env}')
        if not s3_access_key or not s3_secret_key:
            raise ValueError('Missing Yandex Object Storage credentials in environment')
        return ResolvedProvider(
            provider_config=provider_config,
            settings=settings,
            api_key=api_key,
            s3_access_key=s3_access_key,
            s3_secret_key=s3_secret_key,
        )

    def storage_client_for_project(self, project: dict[str, Any]) -> YandexStorageClient:
        resolved = self.resolve_provider(project['provider_config_id'])
        bucket = resolved.settings.get('bucket')
        endpoint = resolved.settings.get('endpoint') or self.settings.default_storage_endpoint
        region = resolved.settings.get('region') or self.settings.default_storage_region
        if not bucket:
            raise ValueError('Yandex bucket is not configured')
        return YandexStorageClient(bucket, endpoint, region, resolved.s3_access_key, resolved.s3_secret_key)

    def ai_client_for_project(self, project: dict[str, Any]) -> tuple[YandexAIStudioClient, dict[str, Any]]:
        resolved = self.resolve_provider(project['provider_config_id'])
        folder_id = resolved.settings.get('folder_id')
        if not folder_id:
            raise ValueError('Yandex folder_id is not configured')
        return YandexAIStudioClient(api_key=resolved.api_key, openai_project=folder_id), resolved.settings

    def object_prefix(self, project: dict[str, Any], category: str) -> str:
        provider = self.resolve_provider(project['provider_config_id'])
        base_prefix = str(provider.settings.get('base_prefix') or '').strip('/ ')
        storage_prefix = str(project['storage_prefix']).strip('/ ')
        return '/'.join([p for p in [base_prefix, storage_prefix, category] if p])

    def sync_project_files(self, project_id: str) -> dict[str, Any]:
        project = self.repo.get_project(project_id)
        if not project:
            raise ValueError('Project not found')
        storage = self.storage_client_for_project(project)
        touched = 0
        current_keys: set[str] = set()
        for category in ['docs', 'user-files', 'raw']:
            prefix = self.object_prefix(project, category)
            objects = storage.list_objects(prefix)
            for obj in objects:
                key = obj['Key']
                current_keys.add(key)
                relative_path = key[len(prefix):].lstrip('/') if key.startswith(prefix) else key
                self.repo.upsert_file(
                    project_id=project['id'],
                    category=category,
                    object_key=key,
                    relative_path=relative_path,
                    size=obj['Size'],
                    etag=obj.get('ETag'),
                    last_modified=obj.get('LastModified'),
                    mime_type=mimetypes.guess_type(relative_path)[0],
                )
                touched += 1
        deleted = self.repo.delete_missing_files(project_id, current_keys)
        return {'project_id': project_id, 'total_files': len(current_keys), 'created_or_updated': touched, 'deleted': deleted}

    def upload_project_file(self, project_id: str, category: str, filename: str, content: bytes, mime_type: str | None) -> dict[str, Any]:
        project = self.repo.get_project(project_id)
        if not project:
            raise ValueError('Project not found')
        storage = self.storage_client_for_project(project)
        prefix = self.object_prefix(project, category)
        safe_name = os.path.basename(filename)
        key = f'{prefix}/{safe_name}'.replace('//', '/')
        storage.upload_bytes(key, content, mime_type)
        file_meta = self.repo.upsert_file(
            project_id=project_id,
            category=category,
            object_key=key,
            relative_path=safe_name,
            size=len(content),
            etag=None,
            last_modified=utcnow_iso(),
            mime_type=mime_type,
        )
        return file_meta

    def download_project_file(self, file_id: str) -> tuple[dict[str, Any], bytes]:
        file_row = self.repo.get_file(file_id)
        if not file_row:
            raise ValueError('File not found')
        project = self.repo.get_project(file_row['project_id'])
        if not project:
            raise ValueError('Project not found')
        storage = self.storage_client_for_project(project)
        content = storage.download_bytes(file_row['object_key'])
        return file_row, content

    async def reindex_project(self, project_id: str) -> dict[str, Any]:
        project = self.repo.get_project(project_id)
        if not project:
            raise ValueError('Project not found')
        self.sync_project_files(project_id)
        files = [f for f in self.repo.list_files(project_id) if f['category'] in {'docs', 'user-files'} and f['filename'].lower().endswith(('.md', '.markdown', '.txt', '.pdf'))]
        if not files:
            raise ValueError('No markdown/txt/pdf files found in project for indexing')

        client, provider_settings = self.ai_client_for_project(project)
        search_chunk_max_tokens = int(provider_settings.get('chunk_max_tokens') or 0)
        search_chunk_overlap_tokens = int(provider_settings.get('chunk_overlap_tokens') or 0)
        vector_store_name_prefix = provider_settings.get('vector_store_name_prefix') or self.settings.default_vector_store_prefix
        ttl_days = int(provider_settings.get('vector_store_ttl_days') or self.settings.default_vector_store_ttl_days)

        run = self.repo.create_reindex_run(project_id)
        uploaded_file_ids: list[str] = []
        vector_store_id: str | None = None
        try:
            desired_name = f"{vector_store_name_prefix}-{project['slug']}"
            existing_list = await client.list_vector_stores()
            current = None
            for item in existing_list.get('data', []) if isinstance(existing_list, dict) else []:
                if item.get('id') == project.get('active_vector_store_id') or item.get('name') == desired_name:
                    current = item
                    break
            if current:
                try:
                    await client.delete_vector_store(current['id'])
                except Exception:
                    pass
            body: dict[str, Any] = {
                'name': desired_name,
                'expires_after': {'anchor': 'last_active_at', 'days': ttl_days},
            }
            if search_chunk_max_tokens > 0:
                body['chunking_strategy'] = {
                    'type': 'static',
                    'static': {
                        'max_chunk_size_tokens': max(100, min(4096, search_chunk_max_tokens)),
                        'chunk_overlap_tokens': max(0, min(2048, search_chunk_overlap_tokens)),
                    },
                }
            created = await client.create_vector_store(body)
            vector_store_id = created['id']

            batch_size = 50
            file_ids: list[str] = []
            for file_row in files:
                _, content = self.download_project_file(file_row['id'])
                uploaded = await client.upload_file(file_row['relative_path'], content, file_row.get('mime_type'))
                file_ids.append(uploaded['id'])
                uploaded_file_ids.append(uploaded['id'])
            for start in range(0, len(file_ids), batch_size):
                slice_ids = file_ids[start:start + batch_size]
                batch_body: dict[str, Any] = {'file_ids': slice_ids}
                if search_chunk_max_tokens > 0:
                    batch_body['chunking_strategy'] = body['chunking_strategy']
                batch = await client.create_vector_store_file_batch(vector_store_id, batch_body)
                await wait_until_batch_ready(client, vector_store_id, str(batch['id']))
            await wait_until_vector_store_ready(client, vector_store_id)
            indexed_at = utcnow_iso()
            self.repo.update_project_index_state(project_id, vector_store_id, indexed_at)
            done = self.repo.finish_reindex_run(run['id'], 'completed', vector_store_id, uploaded_file_ids)
            return {
                'project_id': project_id,
                'vector_store_id': vector_store_id,
                'uploaded_files': len(uploaded_file_ids),
                'run_id': done['id'],
                'started_at': run['started_at'],
                'finished_at': done['finished_at'],
            }
        except Exception as exc:
            self.repo.finish_reindex_run(run['id'], 'failed', vector_store_id, uploaded_file_ids, str(exc))
            raise

    async def query_project(self, project_id: str, question: str, session_id: str | None = None, editor_context: str | None = None) -> dict[str, Any]:
        project = self.repo.get_project(project_id)
        if not project:
            raise ValueError('Project not found')
        if not project.get('active_vector_store_id'):
            raise ValueError('Project has no active vector store. Run reindex first.')

        client, provider_settings = self.ai_client_for_project(project)
        generation_model = provider_settings.get('generation_model') or self.settings.default_generation_model
        if not generation_model:
            raise ValueError('Generation model is not configured')

        actual_question = question.strip()
        if editor_context:
            actual_question += '\n\n---\nКонтекст из VSCode:\n' + editor_context.strip()

        previous_response_id = None
        if session_id:
            session = self.repo.get_session(session_id)
            if session and session.get('project_id') == project_id:
                previous_response_id = session.get('last_response_id')

        search_resp = await client.search_vector_store(
            project['active_vector_store_id'],
            actual_question,
            int(provider_settings.get('search_max_results') or self.settings.default_search_max_results),
        )

        search_results = search_resp.get('data', []) if isinstance(search_resp, dict) else []

        if not search_results:
            return {
                'answer': 'В документации проекта не найдено релевантных фрагментов по этому запросу.',
                'sources': [],
                'raw_text': '',
                'response_id': None,
            }

        context_parts: list[str] = []
        sources: list[dict[str, Any]] = []

        for item in search_results:
            filename = item.get('filename')
            score = item.get('score')
            content_list = item.get('content', [])
            text_parts: list[str] = []

            for c in content_list:
                if c.get('type') == 'text' and c.get('valid'):
                    chunk = (c.get('text') or '').strip()
                    if chunk:
                        text_parts.append(chunk)

            chunk_text = '\n'.join(text_parts).strip()
            if not chunk_text:
                continue

            context_parts.append(f'Источник: {filename}\nФрагмент:\n{chunk_text}')
            sources.append({
                'file': filename,
                'quote': chunk_text[:800],
                'page': item.get('page') if isinstance(item.get('page'), int) else None,
                'line': f'score={score}',
            })

        if not context_parts:
            return {
                'answer': 'В документации проекта не найдено пригодных текстовых фрагментов для ответа.',
                'sources': [],
                'raw_text': '',
                'response_id': None,
            }

        context_text = '\n\n---\n\n'.join(context_parts)

        instruction = (
            'Ты — технический ассистент по языку LuNA. '
            'Отвечай по-русски. '
            'Используй только переданные фрагменты документации проекта. '
            'Не выдумывай факты. '
            'Если во фрагментах нет ответа, честно скажи об этом.'
        )

        body = {
            'model': generation_model,
            'input': [
                {'role': 'system', 'content': [{'type': 'input_text', 'text': instruction}]},
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'input_text',
                            'text': (
                                f'Вопрос пользователя:\n{actual_question}\n\n'
                                f'Фрагменты документации:\n{context_text}\n\n'
                                'Сформируй ответ только на основе этих фрагментов.'
                            ),
                        }
                    ],
                },
            ],
        }

        if previous_response_id:
            body['previous_response_id'] = previous_response_id

        response = await client.create_response(body)
        text, _ = extract_answer_and_sources(response)

        if session_id:
            self.repo.upsert_session(session_id, project_id, response.get('id'))

        return {
            'answer': text,
            'sources': sources,
            'raw_text': text,
            'response_id': response.get('id'),
        }
