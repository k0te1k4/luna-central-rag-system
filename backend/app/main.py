from __future__ import annotations

import json
import mimetypes
from pathlib import Path

import mistune
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import get_settings
from .repository import Repo
from .schemas import (
    FileOut,
    HealthOut,
    ProjectCreate,
    ProjectOut,
    ProviderConfigCreate,
    ProviderConfigOut,
    QueryRequest,
    QueryResponse,
    ReindexResult,
    SyncResult,
)
from .services import ProjectService

settings = get_settings()
repo = Repo()
service = ProjectService()

app = FastAPI(title=settings.app_name)
base_dir = Path(__file__).parent
app.mount('/static', StaticFiles(directory=str(base_dir / 'static')), name='static')
templates = Jinja2Templates(directory=str(base_dir / 'templates'))
markdown_renderer = mistune.create_markdown()


@app.get('/api/health', response_model=HealthOut)
def health() -> HealthOut:
    return HealthOut(status='ok', app_name=settings.app_name)


@app.get('/api/provider-configs', response_model=list[ProviderConfigOut])
def list_provider_configs() -> list[ProviderConfigOut]:
    return [ProviderConfigOut(**item) for item in repo.list_provider_configs()]


@app.post('/api/provider-configs', response_model=ProviderConfigOut)
def create_provider_config(payload: ProviderConfigCreate) -> ProviderConfigOut:
    try:
        created = repo.create_provider_config(payload.model_dump())
        return ProviderConfigOut(**created)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get('/api/projects', response_model=list[ProjectOut])
def list_projects() -> list[ProjectOut]:
    return [ProjectOut(**item) for item in repo.list_projects()]


@app.post('/api/projects', response_model=ProjectOut)
def create_project(payload: ProjectCreate) -> ProjectOut:
    try:
        created = repo.create_project(payload.model_dump())
        return ProjectOut(**created)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get('/api/projects/{project_id}', response_model=ProjectOut)
def get_project(project_id: str) -> ProjectOut:
    project = repo.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    return ProjectOut(**project)


@app.post('/api/projects/{project_id}/sync', response_model=SyncResult)
def sync_project(project_id: str) -> SyncResult:
    try:
        return SyncResult(**service.sync_project_files(project_id))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post('/api/projects/{project_id}/reindex', response_model=ReindexResult)
async def reindex_project(project_id: str) -> ReindexResult:
    try:
        return ReindexResult(**(await service.reindex_project(project_id)))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get('/api/projects/{project_id}/files', response_model=list[FileOut])
def list_project_files(project_id: str, category: str | None = None) -> list[FileOut]:
    project = repo.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    return [FileOut(**item) for item in repo.list_files(project_id, category)]


@app.post('/api/projects/{project_id}/files', response_model=FileOut)
async def upload_project_file(project_id: str, category: str = Form(...), file: UploadFile = File(...)) -> FileOut:
    if category not in {'docs', 'user-files', 'raw'}:
        raise HTTPException(status_code=400, detail='Invalid category')
    content = await file.read()
    try:
        item = service.upload_project_file(project_id, category, file.filename or 'upload.bin', content, file.content_type)
        return FileOut(**item)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get('/api/files/{file_id}', response_model=FileOut)
def get_file(file_id: str) -> FileOut:
    item = repo.get_file(file_id)
    if not item:
        raise HTTPException(status_code=404, detail='File not found')
    return FileOut(**item)


@app.get('/api/files/{file_id}/content')
def get_file_content(file_id: str, download: bool = False):
    try:
        file_row, content = service.download_project_file(file_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    mime = file_row.get('mime_type') or mimetypes.guess_type(file_row['filename'])[0] or 'application/octet-stream'
    headers = {}
    disposition = 'attachment' if download or not (file_row['filename'].lower().endswith('.md') or file_row['filename'].lower().endswith('.pdf')) else 'inline'
    headers['Content-Disposition'] = f'{disposition}; filename="{file_row["filename"]}"'
    return Response(content=content, media_type=mime, headers=headers)


@app.get('/api/files/{file_id}/markdown', response_class=HTMLResponse)
def render_markdown(file_id: str):
    try:
        file_row, content = service.download_project_file(file_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if not file_row['filename'].lower().endswith(('.md', '.markdown', '.txt')):
        raise HTTPException(status_code=400, detail='Not a markdown/text file')
    text = content.decode('utf-8', errors='replace')
    html = markdown_renderer(text)
    return HTMLResponse(f"""
    <!doctype html><html lang='ru'><head><meta charset='utf-8'><title>{file_row['filename']}</title>
    <link rel='stylesheet' href='/static/styles.css'></head><body class='markdown-body'>
    <div class='page'><a href='/project/{file_row['project_id']}'>← Назад к проекту</a><h1>{file_row['filename']}</h1>{html}</div></body></html>
    """)


@app.post('/api/projects/{project_id}/query', response_model=QueryResponse)
async def query_project(project_id: str, payload: QueryRequest) -> QueryResponse:
    try:
        result = await service.query_project(project_id, payload.question, payload.session_id, payload.editor_context)
        return QueryResponse(**result)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get('/', response_class=HTMLResponse)
def ui_index(request: Request):
    return templates.TemplateResponse(
        'index.html',
        {
            'request': request,
            'projects': repo.list_projects(),
            'provider_configs': repo.list_provider_configs(),
            'settings': settings,
        },
    )


@app.get('/project/{project_id}', response_class=HTMLResponse)
def ui_project(request: Request, project_id: str):
    project = repo.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail='Project not found')
    files = repo.list_files(project_id)
    provider = repo.get_provider_config(project['provider_config_id'])
    return templates.TemplateResponse(
        'project.html',
        {
            'request': request,
            'project': project,
            'provider': provider,
            'files': files,
        },
    )
