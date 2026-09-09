const state = { token: localStorage.getItem('shortly_token'), authMode: 'login', links: [] };
const $ = (selector) => document.querySelector(selector);
const authModal = $('#auth-modal');

function setView() {
  document.querySelectorAll('.guest-only').forEach((el) => el.style.display = state.token ? 'none' : '');
  document.querySelectorAll('.user-only').forEach((el) => el.style.display = state.token ? 'block' : 'none');
  if (state.token) loadWorkspace();
}
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { ...options, headers });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function openAuth(mode) {
  state.authMode = mode; $('#auth-title').textContent = mode === 'login' ? 'Welcome back' : 'Create your workspace';
  $('#auth-subtitle').textContent = mode === 'login' ? 'Log in to your link workspace.' : 'One account, every link in one place.';
  $('#auth-submit').innerHTML = `${mode === 'login' ? 'Log in' : 'Create account'} <span>→</span>`;
  $('#switch-copy').textContent = mode === 'login' ? 'New to Shortly?' : 'Already have an account?';
  $('#switch-auth').textContent = mode === 'login' ? 'Create an account' : 'Log in'; $('#auth-message').textContent = ''; authModal.classList.add('open'); $('#email-input').focus();
}
document.querySelectorAll('[data-open-auth]').forEach((button) => button.addEventListener('click', () => openAuth(button.dataset.openAuth)));
$('#close-auth').addEventListener('click', () => authModal.classList.remove('open'));
authModal.addEventListener('click', (event) => { if (event.target === authModal) authModal.classList.remove('open'); });
$('#switch-auth').addEventListener('click', () => openAuth(state.authMode === 'login' ? 'signup' : 'login'));
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const message = $('#auth-message'); message.textContent = '';
  const body = { email: $('#email-input').value.trim(), password: $('#password-input').value };
  try { const result = await request(`/api/auth/${state.authMode === 'login' ? 'login' : 'signup'}`, { method: 'POST', body: JSON.stringify(body) });
    if (state.authMode === 'signup') { state.authMode = 'login'; message.className = 'form-message success'; message.textContent = 'Account created. Logging you in…'; const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }); state.token = login.token; }
    else state.token = result.token; localStorage.setItem('shortly_token', state.token); authModal.classList.remove('open'); setView(); toast('Welcome to Shortly.');
  } catch (error) { message.className = 'form-message'; message.textContent = error.message; }
});
$('#logout').addEventListener('click', () => { localStorage.removeItem('shortly_token'); state.token = null; state.links = []; setView(); });
$('#focus-create').addEventListener('click', () => $('#url-input').focus()); $('#refresh-links').addEventListener('click', loadWorkspace);
$('#shorten-form').addEventListener('submit', async (event) => { event.preventDefault(); const message = $('#form-message'); message.textContent = ''; try { await request('/api/links', { method: 'POST', body: JSON.stringify({ original_url: $('#url-input').value.trim() }) }); $('#url-input').value = ''; message.className = 'form-message success'; message.textContent = 'Link created successfully.'; loadWorkspace(); } catch (error) { message.className = 'form-message'; message.textContent = error.message; } });
async function loadWorkspace() { try { const [user, links] = await Promise.all([request('/api/auth/me'), request('/api/links')]); $('#user-email').textContent = user.email; state.links = links; $('#link-count').textContent = links.length; renderLinks(); loadClickCount(links); } catch (error) { if (/token|auth|unauthorized/i.test(error.message)) { localStorage.removeItem('shortly_token'); state.token = null; setView(); } else toast(error.message); } }
async function loadClickCount(links) { try { const stats = await Promise.all(links.map((link) => request(`/api/links/${link.id}/stats`))); $('#click-count').textContent = stats.reduce((sum, stat) => sum + stat.total_clicks, 0); } catch { $('#click-count').textContent = '—'; } }
function renderLinks() { const list = $('#links-list'); if (!state.links.length) { list.innerHTML = '<div class="empty-state">No links yet. Make your first one above.</div>'; return; } list.innerHTML = state.links.map((link) => { const shortUrl = `${location.origin}/${link.short_code}`; return `<article class="link-row"><div><a class="short-url" href="/${link.short_code}" target="_blank" rel="noreferrer">${shortUrl}</a><span class="link-status ${link.is_active ? '' : 'off'}">${link.is_active ? '● Active' : '● Disabled'}</span><span class="link-url" title="${escapeHtml(link.original_url)}">${escapeHtml(link.original_url)}</span></div><div class="row-actions"><button class="row-button" data-copy="${shortUrl}">Copy</button><button class="row-button" data-toggle="${link.id}" data-active="${link.is_active}">${link.is_active ? 'Disable' : 'Enable'}</button><button class="row-button danger" data-delete="${link.id}">Delete</button></div></article>`; }).join('');
  list.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => { await navigator.clipboard.writeText(button.dataset.copy); toast('Short link copied.'); }));
  list.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => { try { await request(`/api/links/${button.dataset.toggle}`, { method: 'PUT', body: JSON.stringify({ is_active: button.dataset.active !== 'true' }) }); loadWorkspace(); } catch (error) { toast(error.message); } }));
  list.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => { if (!confirm('Delete this short link?')) return; try { await request(`/api/links/${button.dataset.delete}`, { method: 'DELETE' }); toast('Link deleted.'); loadWorkspace(); } catch (error) { toast(error.message); } }));
}
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
setView();
