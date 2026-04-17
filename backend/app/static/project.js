const actionResult = document.getElementById('action-result');
const uploadForm = document.getElementById('upload-form');
const uploadResult = document.getElementById('upload-result');
const queryForm = document.getElementById('query-form');
const queryResult = document.getElementById('query-result');

async function runProjectAction(action) {
  actionResult.textContent = action === 'sync' ? 'Синхронизация…' : 'Reindex…';
  const response = await fetch(`/api/projects/${window.PROJECT_ID}/${action}`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    actionResult.textContent = data.detail || JSON.stringify(data, null, 2);
    return;
  }
  actionResult.textContent = JSON.stringify(data, null, 2);
  window.location.reload();
}

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => runProjectAction(btn.dataset.action));
});

if (uploadForm) {
  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(uploadForm);
    uploadResult.textContent = 'Загрузка…';
    const response = await fetch(`/api/projects/${window.PROJECT_ID}/files`, { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) {
      uploadResult.textContent = data.detail || JSON.stringify(data, null, 2);
      return;
    }
    uploadResult.textContent = JSON.stringify(data, null, 2);
    window.location.reload();
  });
}

if (queryForm) {
  queryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(queryForm);
    queryResult.innerHTML = '<p class="muted">Выполняю запрос…</p>';
    const response = await fetch(`/api/projects/${window.PROJECT_ID}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: formData.get('question'),
        session_id: `web-${window.PROJECT_ID}`,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      queryResult.innerHTML = `<pre class="result">${data.detail || JSON.stringify(data, null, 2)}</pre>`;
      return;
    }
    const sources = (data.sources || []).map((src) => {
      const meta = [src.file, src.page ? `стр. ${src.page}` : null, src.line || null].filter(Boolean).join(', ');
      const quote = src.quote ? `<div class="muted small">${src.quote}</div>` : '';
      return `<li><strong>${meta || 'источник'}</strong>${quote}</li>`;
    }).join('');
    queryResult.innerHTML = `
      <h3>Ответ</h3>
      <p>${(data.answer || '').replace(/\n/g, '<br>')}</p>
      <h3>Источники</h3>
      <ul>${sources || '<li>Источники не вернулись</li>'}</ul>
      <details><summary>Сырой ответ</summary><pre class="result">${JSON.stringify(data, null, 2)}</pre></details>
    `;
  });
}
