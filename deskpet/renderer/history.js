// 待办事项历史
const ipc = window.api;
const $ = (s) => document.querySelector(s);

const pad = (n) => String(n).padStart(2, '0');
function when(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dur(a, b) {
  if (!a || !b) return '';
  const m = Math.max(0, Math.round((b - a) / 60000));
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

async function main() {
  const profile = (await ipc.getProfile()) || {};
  const list = profile.history || [];
  $('#s-count').textContent = list.length;
  $('#s-exp').textContent = list.reduce((a, b) => a + (b.exp || 0), 0);
  $('#s-focus').textContent = list.filter((h) => h.focus).length;

  $('#list').innerHTML = list.length ? `
    <table><thead><tr><th>事项</th><th>完成时间</th><th>用时</th><th>经验</th></tr></thead>
    <tbody>${list.map((h) => `<tr>
      <td class="t">${escapeHtml(h.text)}${h.focus ? ' <span class="badge">专注</span>' : ''}</td>
      <td class="d">${when(h.doneAt)}</td>
      <td class="d">${dur(h.createdAt, h.doneAt)}</td>
      <td class="d">+${h.exp || 0}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">还没有完成过待办事项</div>';

  $('#clear').onclick = () => {
    if (!confirm('清空全部历史记录？')) return;
    profile.history = [];
    ipc.saveProfile(profile);
    location.reload();
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

main();
