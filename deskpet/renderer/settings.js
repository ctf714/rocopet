// 设置页：只改配置项
const ipc = window.api;
const $ = (s) => document.querySelector(s);

let profile = {};
let pack = null;
let forms = [];

function bindSwitch(el, txtEl, get, set, onText = '开', offText = '关') {
  const paint = () => {
    const v = !!get();
    el.classList.toggle('on', v);
    txtEl.textContent = v ? onText : offText;
  };
  el.onclick = () => { set(!get()); paint(); };
  paint();
}

async function main() {
  profile = (await ipc.getProfile()) || {};
  try { pack = await ipc.getPack(); } catch { pack = null; }

  const m = pack && pack.manifest;
  $('#pet-name').textContent = m ? `${m.chain || ''}${m.form_name ? ' · ' + m.form_name : ''}` : '未加载宠物包';

  forms = (m && m.chain_forms) ? m.chain_forms.slice().sort((a, b) => (a.stage || 0) - (b.stage || 0))
    : (m ? [{ asset: m.form, name: m.form_name }] : []);
  $('#form').innerHTML = forms.map((f, i) =>
    `<option value="${i}">${f.name || f.asset}${f.stage ? '（阶段 ' + f.stage + '）' : ''}</option>`).join('');
  $('#form').value = String(Math.min(profile.formIndex || 0, forms.length - 1));

  $('#nickname').value = profile.nickname || '';
  $('#size').value = profile.px_per_cm || (m && m.traits && m.traits.px_per_cm) || 2.0;
  $('#vol').value = Math.round((profile.volume === undefined ? 0.6 : profile.volume) * 100);
  const paintSize = () => { $('#size-v').textContent = (+$('#size').value).toFixed(1) + '×'; };
  const paintVol = () => { $('#vol-v').textContent = $('#vol').value + '%'; };
  $('#size').oninput = paintSize; $('#vol').oninput = paintVol;
  paintSize(); paintVol();

  bindSwitch($('#pass'), $('#pass-txt'),
    () => profile.passthrough, (v) => { profile.passthrough = v; });

  const need = 40 + (profile.level || 1) * 20;
  $('#lv').textContent = 'Lv.' + (profile.level || 1);
  $('#exp').textContent = `${Math.round(profile.exp || 0)}/${need}`;
  $('#aff').textContent = Math.round(profile.affection || 0);
  $('#todo-n').textContent = ((profile.todos || []).filter((t) => !t.done)).length;

  $('#reset').onclick = () => {
    if (!confirm('把等级、经验、好感度、待办与历史全部清零？')) return;
    Object.assign(profile, { level: 1, exp: 0, affection: 0, formIndex: 0, todos: [], history: [] });
    ipc.saveProfile(profile);
    location.reload();
  };
  $('#apply').onclick = async () => {
    profile.nickname = $('#nickname').value.trim();
    profile.px_per_cm = +$('#size').value;
    profile.volume = (+$('#vol').value) / 100;
    profile.formIndex = +$('#form').value;
    // 描边与卡通光是固定风格，不在设置里暴露；异色 / 宠物包跟随打包时的选择
    profile.outline = true; profile.toon = true;
    await ipc.saveProfile(profile);
    await ipc.setPassthrough(!!profile.passthrough);
    window.close();
  };
}

main();
