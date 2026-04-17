from __future__ import annotations

import asyncio
import json
import mimetypes
import os
from dataclasses import dataclass
from typing import Any

import boto3
import httpx


class YandexApiError(RuntimeError):
    pass


@dataclass
class ResolvedProvider:
    provider_config: dict[str, Any]
    settings: dict[str, Any]
    api_key: str
    s3_access_key: str
    s3_secret_key: str


class YandexAIStudioClient:
    def __init__(self, api_key: str, openai_project: str):
        self.api_key = api_key
        self.openai_project = openai_project
        self.base = 'https://ai.api.cloud.yandex.net/v1'

    def headers(self) -> dict[str, str]:
        return {
            'Authorization': f'Api-Key {self.api_key}',
            'OpenAI-Project': self.openai_project,
        }

    async def request_json(self, method: str, url: str, json_body: Any | None = None, files: Any | None = None) -> Any:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.request(method, url, headers=self.headers(), json=json_body, files=files)
            text = resp.text
            if resp.status_code >= 400:
                raise YandexApiError(f'Yandex AI Studio API error {resp.status_code}: {text}')
            if not text:
                return None
            try:
                return resp.json()
            except Exception:
                return text

    async def create_response(self, body: dict[str, Any]) -> Any:
        return await self.request_json('POST', f'{self.base}/responses', json_body=body)

    async def list_vector_stores(self) -> Any:
        return await self.request_json('GET', f'{self.base}/vector_stores')

    async def get_vector_store(self, vector_store_id: str) -> Any:
        return await self.request_json('GET', f'{self.base}/vector_stores/{vector_store_id}')

    async def create_vector_store(self, body: dict[str, Any]) -> Any:
        return await self.request_json('POST', f'{self.base}/vector_stores', json_body=body)

    async def delete_vector_store(self, vector_store_id: str) -> None:
        await self.request_json('DELETE', f'{self.base}/vector_stores/{vector_store_id}')

    async def upload_file(self, filename: str, content: bytes, mime_type: str | None = None, purpose: str = 'assistants') -> Any:
        mime = mime_type or mimetypes.guess_type(filename)[0] or 'application/octet-stream'
        files = {
            'file': (filename, content, mime),
            'purpose': (None, purpose),
        }
        return await self.request_json('POST', f'{self.base}/files', files=files)

    async def delete_file(self, file_id: str) -> None:
        await self.request_json('DELETE', f'{self.base}/files/{file_id}')

    async def create_vector_store_file_batch(self, vector_store_id: str, body: dict[str, Any]) -> Any:
        return await self.request_json('POST', f'{self.base}/vector_stores/{vector_store_id}/file_batches', json_body=body)

    async def get_vector_store_file_batch(self, vector_store_id: str, batch_id: str) -> Any:
        return await self.request_json('GET', f'{self.base}/vector_stores/{vector_store_id}/file_batches/{batch_id}')

    async def search_vector_store(self, vector_store_id: str, query: str, max_num_results: int = 5) -> Any:
        return await self.request_json(
            'POST',
            f'{self.base}/vector_stores/{vector_store_id}/search',
            json_body={
                'query': query,
                'max_num_results': max_num_results,
            },
        )

class YandexStorageClient:
    def __init__(self, bucket: str, endpoint: str, region: str, access_key: str, secret_key: str):
        self.bucket = bucket
        self.client = boto3.client(
            's3',
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
        )

    def list_objects(self, prefix: str) -> list[dict[str, Any]]:
        paginator = self.client.get_paginator('list_objects_v2')
        out: list[dict[str, Any]] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for item in page.get('Contents', []):
                out.append(
                    {
                        'Key': item['Key'],
                        'Size': int(item.get('Size', 0)),
                        'ETag': str(item.get('ETag', '')).strip('"') or None,
                        'LastModified': item.get('LastModified').isoformat() if item.get('LastModified') else None,
                    }
                )
        return out

    def upload_bytes(self, key: str, content: bytes, content_type: str | None = None) -> None:
        extra = {'ContentType': content_type} if content_type else {}
        self.client.put_object(Bucket=self.bucket, Key=key, Body=content, **extra)

    def download_bytes(self, key: str) -> bytes:
        resp = self.client.get_object(Bucket=self.bucket, Key=key)
        return resp['Body'].read()


def extract_answer_and_sources(resp: Any) -> tuple[str, list[dict[str, Any]]]:
    sources: list[dict[str, Any]] = []
    texts: list[str] = []
    output = resp.get('output') or resp.get('output_items') or []
    for item in output:
        if item.get('type') != 'message':
            continue
        for part in item.get('content', []):
            if part.get('type') != 'output_text':
                continue
            text = str(part.get('text') or '')
            if text:
                texts.append(text)
            for ann in part.get('annotations') or []:
                file_name = ann.get('filename') or (ann.get('file') or {}).get('filename') or ann.get('file_name') or ann.get('file_id')
                quote = ann.get('quote') or ann.get('text')
                page = ann.get('page_number') if isinstance(ann.get('page_number'), int) else ann.get('page') if isinstance(ann.get('page'), int) else None
                line = ann.get('line') or ann.get('location')
                sources.append({'file': file_name, 'quote': quote, 'page': page, 'line': line})
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for src in sources:
        key = json.dumps({'f': src.get('file') or '', 'p': src.get('page') or '', 'l': src.get('line') or '', 'q': (src.get('quote') or '')[:120]}, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(src)
    return ''.join(texts).strip(), deduped


async def wait_until_vector_store_ready(client: YandexAIStudioClient, vector_store_id: str, timeout_seconds: int = 1800) -> None:
    waited = 0
    while waited < timeout_seconds:
        info = await client.get_vector_store(vector_store_id)
        status = str(info.get('status') or '')
        if status == 'completed':
            return
        if status in {'failed', 'cancelled'}:
            raise YandexApiError(f'Vector store status: {status}')
        await asyncio.sleep(1)
        waited += 1
    raise YandexApiError('Vector store readiness timeout')


async def wait_until_batch_ready(client: YandexAIStudioClient, vector_store_id: str, batch_id: str, timeout_seconds: int = 1800) -> None:
    waited = 0
    while waited < timeout_seconds:
        info = await client.get_vector_store_file_batch(vector_store_id, batch_id)
        status = str(info.get('status') or '')
        if status == 'completed':
            return
        if status in {'failed', 'cancelled'}:
            raise YandexApiError(f'Vector store batch status: {status}')
        await asyncio.sleep(1)
        waited += 1
    raise YandexApiError('Vector store batch timeout')
