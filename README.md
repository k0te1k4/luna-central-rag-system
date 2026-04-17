# LuNA Central RAG System

## Аннотация

**LuNA Central RAG System** — это прототип центральной модульной системы управления базой знаний для экосистемы **LuNA**, в которой логика retrieval-augmented generation (RAG), ранее встроенная непосредственно в расширение Visual Studio Code, вынесена в отдельный backend-сервис.

Цель проекта — отделить пользовательский интерфейс и клиентские интеграции от логики хранения, индексации и поиска по документации, а также подготовить архитектурную основу для дальнейшего расширения системы новыми провайдерами RAG, новыми каналами взаимодействия с пользователем и дополнительными функциями управления знаниями.

В текущей версии реализованы:
- отдельный backend для работы с проектами, файлами и конфигурациями провайдера;
- web-интерфейс для просмотра проектов, файлов, запуска переиндексации и выполнения тестового запроса;
- интеграция с **Yandex Object Storage** и **Yandex AI Studio Vector Store**;
- загрузка, просмотр и повторная индексация markdown/pdf-файлов;
- обновлённый VS Code-плагин, который обращается к backend вместо прямого взаимодействия с Yandex API;
- запуск всей системы через Docker Compose с вынесением конфигурации в `.env`.

---

## Основные возможности

### 1. Централизованное управление проектами
Каждый проект хранит:
- название;
- уникальный `slug`;
- описание;
- ссылку на конфигурацию провайдера;
- префикс хранения в Object Storage;
- идентификатор активного Vector Store;
- время последней индексации.

### 2. Управление файлами базы знаний
Для каждого проекта поддерживается хранение файлов в категориях:
- `docs`
- `user-files`
- `raw`

При этом в индексацию участвуют только файлы из:
- `docs`
- `user-files`

Поддерживаемые форматы индексации:
- `.md`
- `.markdown`
- `.txt`
- `.pdf`

### 3. Интеграция с Yandex Cloud
Система использует:
- **Yandex Object Storage** — для физического хранения файлов;
- **Yandex AI Studio Vector Store** — для индексации и retrieval;
- **Yandex Responses API** — для генерации ответа на основе найденных фрагментов.

### 4. Web-интерфейс администратора
Доступны:
- список проектов;
- просмотр файлов проекта;
- загрузка новых файлов;
- ручная синхронизация с Object Storage;
- ручная переиндексация;
- тестовый запрос к базе знаний;
- просмотр markdown;
- открытие PDF в браузере.

### 5. Интеграция с Visual Studio Code
Обновлённый VS Code-плагин:
- больше не выполняет прямые запросы к Yandex для чата и переиндексации;
- обращается к backend по HTTP API;
- передаёт вопрос пользователя и, при необходимости, контекст редактора.

---

## Архитектура системы

### Общая схема

```text
Пользователь
   │
   ├── Web UI
   │
   └── VS Code extension
          │
          ▼
     LuNA Backend (FastAPI)
          │
          ├── SQLite (метаданные)
          ├── Yandex Object Storage (файлы)
          ├── Yandex Vector Store (индексация и retrieval)
          └── Yandex Generation Model (генерация ответа)
```

### Архитектурный принцип

Система построена по принципу **разделения транспорта, логики и хранилища**:

- **транспортный уровень**: web UI и VS Code extension;
- **backend-уровень**: маршрутизация запросов, управление проектами, файлами, переиндексацией, retrieval и генерацией ответа;
- **уровень хранения**: SQLite + Object Storage + Vector Store.

Такое разделение позволяет:
- заменить клиентские интерфейсы без переписывания логики RAG;
- расширить поддержку провайдеров;
- централизованно контролировать конфигурации и знания;
- подготовить систему к введению авторизации и новых транспортов.

---

## Технологический стек

### Backend
- **Python 3.11**
- **FastAPI**
- **Jinja2**
- **SQLite**

### Frontend/UI
- Серверные HTML-шаблоны на **Jinja2**
- JavaScript для клиентских действий на страницах интерфейса

### Облачные сервисы
- **Yandex Object Storage**
- **Yandex AI Studio**
- **Yandex Vector Stores**
- **Yandex Responses API**

### Развёртывание
- **Docker**
- **Docker Compose**

### Клиентская интеграция
- **Visual Studio Code Extension (TypeScript)**

---

## Структура проекта

```text
luna_central_system/
├── backend/
│   ├── app/
│   │   ├── main.py              # точка входа FastAPI
│   │   ├── services.py          # бизнес-логика проектов, файлов, reindex, query
│   │   ├── repository.py        # работа с БД
│   │   ├── db.py                # инициализация SQLite
│   │   ├── schemas.py           # pydantic-схемы API
│   │   ├── config.py            # загрузка конфигурации из env
│   │   ├── yandex_client.py     # клиенты Yandex APIs
│   │   ├── templates/           # HTML-шаблоны UI
│   │   └── static/              # CSS/JS-ресурсы UI
│   ├── requirements.txt
│   └── Dockerfile
├── vscode-extension/            # обновлённый VS Code-плагин
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Модель данных

### 1. ProviderConfig
Сущность описывает параметры подключения к провайдеру RAG.

Основные поля:
- `name`
- `provider`
- `settings`
- `is_default`

Пример параметров:
- `folder_id`
- `bucket`
- `endpoint`
- `region`
- `base_prefix`
- `generation_model`
- `vector_store_name_prefix`
- `search_max_results`
- `chunk_max_tokens`
- `chunk_overlap_tokens`

### 2. Project
Сущность проекта содержит:
- `name`
- `slug`
- `description`
- `provider_config_id`
- `storage_prefix`
- `active_vector_store_id`
- `last_indexed_at`

### 3. File
Метаданные файла:
- `category`
- `object_key`
- `relative_path`
- `filename`
- `mime_type`
- `size`
- `etag`
- `last_modified`
- `indexed_at`
- `status`

### 4. ReindexRun
Используется для фиксации процесса переиндексации:
- статус выполнения;
- время запуска и завершения;
- идентификатор созданного vector store;
- список загруженных файлов.

### 5. ChatSession
Используется для сохранения состояния взаимодействия:
- проект;
- идентификатор предыдущего ответа модели;
- время обновления сессии.

---

## Логика работы системы

### 1. Загрузка файла
При загрузке файла через web UI:
1. backend принимает multipart-запрос;
2. файл сохраняется в соответствующий путь в Object Storage;
3. его метаданные записываются в SQLite;
4. файл становится доступен в списке файлов проекта.

### 2. Синхронизация файлов
Команда синхронизации:
1. читает содержимое Object Storage по префиксу проекта;
2. обновляет локальные метаданные файлов;
3. удаляет из БД записи о файлах, которых больше нет в хранилище.

### 3. Переиндексация
Команда reindex:
1. синхронизирует метаданные с Object Storage;
2. выбирает документы допустимых типов из категорий `docs` и `user-files`;
3. создаёт новый Vector Store;
4. загружает документы в Yandex AI Studio;
5. создаёт file batches;
6. дожидается завершения индексации;
7. сохраняет `active_vector_store_id` в проекте;
8. проставляет `indexed_at` у файлов проекта.

### 4. Выполнение запроса
Рекомендуемая логика запроса в рабочей версии:
1. backend выполняет **явный retrieval** по `Vector Store Search`;
2. получает набор релевантных чанков;
3. формирует контекст из найденных фрагментов;
4. передаёт его в модель генерации;
5. возвращает пользователю ответ и список источников.

Такой подход надёжнее, чем полностью полагаться на автоматический вызов инструмента `file_search` со стороны модели.

---

## Организация хранения данных

Для каждого проекта используется схема хранения в Object Storage:

```text
{base_prefix}/{storage_prefix}/docs/
{base_prefix}/{storage_prefix}/user-files/
{base_prefix}/{storage_prefix}/raw/
```

Пример:

```text
luna-kb/luna-programming/docs/
luna-kb/luna-programming/user-files/
luna-kb/luna-programming/raw/
```

Назначение каталогов:
- `docs` — основная проектная документация;
- `user-files` — дополнительные загружаемые материалы;
- `raw` — вспомогательные файлы, не участвующие в индексации.

---

## HTTP API

### Служебные маршруты
- `GET /api/health` — проверка состояния backend

### Конфигурации провайдера
- `GET /api/provider-configs`
- `POST /api/provider-configs`

### Проекты
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/{project_id}`

### Файлы и синхронизация
- `POST /api/projects/{project_id}/sync`
- `POST /api/projects/{project_id}/reindex`
- `GET /api/projects/{project_id}/files`
- `POST /api/projects/{project_id}/files`
- `GET /api/files/{file_id}`
- `GET /api/files/{file_id}/content`
- `GET /api/files/{file_id}/markdown`

### Запрос к базе знаний
- `POST /api/projects/{project_id}/query`

Пример тела запроса:

```json
{
  "question": "Что говорится в документации LuNA о типах выражений?",
  "session_id": "demo-session",
  "editor_context": ""
}
```

Пример ответа:

```json
{
  "answer": "В документации LuNA указано, что в языке определены типы выражений int, real, string, value и name.",
  "sources": [
    {
      "file": "luna_lang_v01.md",
      "quote": "В языке LuNA определены следующие типы выражений: int, real, string...",
      "page": null,
      "line": "score=0.49"
    }
  ],
  "raw_text": "...",
  "response_id": "..."
}
```

---

## Требования к окружению

Для локального запуска необходимы:

- Docker
- Docker Compose
- доступ к Yandex Cloud
- действующие значения:
  - `YANDEX_API_KEY`
  - `YANDEX_FOLDER_ID`
  - `YANDEX_S3_ACCESS_KEY`
  - `YANDEX_S3_SECRET_KEY`
  - `YANDEX_S3_BUCKET`

---

## Настройка `.env`

Скопируйте шаблон:

```bash
cp .env.example .env
```

Заполните `.env`.

### Обязательные переменные

```env
APP_NAME=LuNA RAG Backend
APP_PORT=8000
PUBLIC_BASE_URL=http://localhost:8000
LUNA_DATA_DIR=/data
LUNA_DB_PATH=/data/luna.db

YANDEX_API_KEY=
YANDEX_FOLDER_ID=
YANDEX_S3_ACCESS_KEY=
YANDEX_S3_SECRET_KEY=
YANDEX_S3_BUCKET=
YANDEX_S3_ENDPOINT=https://storage.yandexcloud.net
YANDEX_S3_REGION=ru-central1
YANDEX_STORAGE_BASE_PREFIX=luna-kb

YANDEX_GENERATION_MODEL=
YANDEX_VECTOR_STORE_PREFIX=luna-kb
YANDEX_VECTOR_STORE_TTL_DAYS=365
YANDEX_SEARCH_MAX_RESULTS=6
YANDEX_CHUNK_MAX_TOKENS=0
YANDEX_CHUNK_OVERLAP_TOKENS=0
```

### Пояснение к параметрам

- `YANDEX_API_KEY` — API key для Yandex AI Studio
- `YANDEX_FOLDER_ID` — идентификатор каталога / проекта Yandex Cloud
- `YANDEX_S3_ACCESS_KEY` — доступ к Object Storage
- `YANDEX_S3_SECRET_KEY` — секретный ключ Object Storage
- `YANDEX_S3_BUCKET` — имя bucket
- `YANDEX_STORAGE_BASE_PREFIX` — общий префикс для документов системы
- `YANDEX_GENERATION_MODEL` — модель генерации ответа
- `YANDEX_SEARCH_MAX_RESULTS` — количество возвращаемых фрагментов retrieval
- `YANDEX_CHUNK_MAX_TOKENS` и `YANDEX_CHUNK_OVERLAP_TOKENS` — параметры чанкинга

---

## Запуск проекта

### Шаг 1. Подготовить конфигурацию

```bash
cp .env.example .env
```

Заполнить `.env` реальными ключами.

### Шаг 2. Запустить контейнеры

```bash
docker compose up --build
```

### Шаг 3. Открыть приложение

После успешного запуска доступны:

- Web UI: `http://localhost:8000/`
- Health endpoint: `http://localhost:8000/api/health`

Проверка:

```bash
curl http://localhost:8000/api/health
```

Ожидаемый ответ:

```json
{"status":"ok","app_name":"LuNA RAG Backend"}
```

---

## Первичная проверка работоспособности

### Сценарий 1. Создание проекта
1. Открыть web UI.
2. Создать `ProviderConfig`.
3. Создать проект и привязать его к созданной конфигурации.

### Сценарий 2. Загрузка документа
1. Перейти на страницу проекта.
2. Выбрать категорию `docs`.
3. Загрузить markdown-файл с документацией LuNA.

### Сценарий 3. Синхронизация и переиндексация
1. Нажать **Синхронизировать файлы из Object Storage**.
2. Нажать **Ручной reindex в Yandex Vector Store**.
3. Убедиться, что:
   - у проекта появился `vector_store_id`;
   - у файлов обновился `indexed_at`;
   - количество `uploaded_files` больше нуля.

### Сценарий 4. Тестовый запрос
Задать вопрос, например:

```text
Что говорится в документации LuNA о типах выражений?
```

Ожидаемый результат:
- возвращается осмысленный ответ;
- отображаются источники;
- в источниках указаны имя файла и текстовый фрагмент.

### Сценарий 5. Проверка markdown/pdf
- markdown должен открываться через встроенный рендеринг;
- PDF должен открываться браузером как `inline`-контент.

---

## Подключение VS Code extension

В папке `vscode-extension` находится обновлённая версия расширения.

Для работы через backend необходимо задать параметры расширения:

- `luna.backend.enabled = true`
- `luna.backend.baseUrl = http://localhost:8000`
- `luna.backend.projectSlug = <slug_проекта>`

После этого:
- чатовые запросы плагина направляются в backend;
- backend выполняет retrieval и генерацию ответа;
- результат возвращается в интерфейс VS Code.

---

## Проверка retrieval отдельно от генерации

Если ответ модели не использует документацию, сначала полезно проверить поиск напрямую по Vector Store.

Пример:

```bash
curl -s -X POST \
  -H "Authorization: Api-Key $YANDEX_API_KEY" \
  -H "OpenAI-Project: $YANDEX_FOLDER_ID" \
  -H "Content-Type: application/json" \
  "https://ai.api.cloud.yandex.net/v1/vector_stores/<VECTOR_STORE_ID>/search" \
  -d '{
    "query": "LuNA язык программирования",
    "max_num_results": 5
  }'
```

Если поиск возвращает чанки, а UI не показывает их в ответе, проблема, как правило, находится уже на этапе генерации, а не индексации.

---

## Типовые проблемы и диагностика

### 1. Docker не может скачать образ
Признак:
- ошибка `TLS handshake timeout`

Причина:
- временные сетевые проблемы при обращении к Docker Hub.

Решение:
```bash
docker pull python:3.11-slim
docker compose up --build
```

### 2. В UI видны файлы, но ответ не использует документацию
Причины:
- не был выполнен reindex;
- вопрос задаётся в другом проекте;
- retrieval не отрабатывает корректно;
- используется слишком общий запрос;
- индекс есть, но generation не использует найденные чанки.

Проверить:
- `vector_store_id` у проекта;
- ответ reindex;
- прямой `search` по Vector Store.

### 3. Источники не отображаются
Причины:
- модель не вернула аннотации;
- retrieval не был выполнен;
- backend извлекает источники только из ответа модели, а не из search results.

Практическое решение:
- выполнять retrieval явно на backend и строить список `sources` из результатов поиска.

### 4. Файл виден в списке, но не участвует в поиске
Причины:
- файл загружен в `raw`;
- тип файла не поддерживается;
- после загрузки не выполнялся reindex.

