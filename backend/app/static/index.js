const projectForm = document.getElementById('project-form');
const projectResult = document.getElementById('project-form-result');

if (projectForm) {
  projectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(projectForm);
    const payload = Object.fromEntries(formData.entries());
    projectResult.textContent = 'Создаю проект…';
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      projectResult.textContent = data.detail || JSON.stringify(data, null, 2);
      return;
    }
    projectResult.textContent = JSON.stringify(data, null, 2);
    window.location.reload();
  });
}
