// Sermon Shorts 화면
'use strict';
const $ = id => document.getElementById(id);
// api = preload가 넘긴 window.api
let S = {}, video = null, clips = [], busy = false;

const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = (t % 60).toFixed(1); return `${m}:${s.padStart(4, '0')}`; };
const parseT = v => { const p = String(v).trim().split(':').map(Number); if (p.some(n => !Number.isFinite(n))) return NaN; return p.reduce((a, x) => a * 60 + x, 0); };
const log = m => { const el = $('log'); el.textContent += `${new Date().toLocaleTimeString('ko-KR', { hour12: false })} ${m}\n`; el.scrollTop = el.scrollHeight; };
const status = (m, err) => { $('status').textContent = m; $('status').className = err ? 'err' : 'muted'; };
const errMsg = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
api.onLog(log);
api.onProgress(p => { $('prog').classList.remove('hidden'); $('bar').style.width = `${Math.round(Math.min(1, p.ratio) * 100)}%`; });

// ---------- 설정 ----------
async function loadSettings() {
  S = await api.settings();
  $('church').value = S.church; $('ending').value = S.ending; $('layout').value = S.layout; $('outDir').textContent = S.outDir;
  if (S.mock) log('시험 모드: AI를 부르지 않고 가짜 결과를 씁니다');
  if (!S.hasKey && !S.mock) { status('먼저 「설정」에서 Gemini API 키를 넣어 주세요.'); }
}
$('openSettings').onclick = () => { $('key').value = ''; $('settings').showModal(); };
$('keyLink').onclick = e => { e.preventDefault(); api.openUrl('https://aistudio.google.com/apikey'); };
$('saveSettings').onclick = async () => {
  const patch = { church: $('church').value.trim(), ending: $('ending').value.trim() };
  if ($('key').value.trim()) patch.key = $('key').value.trim();
  await api.saveSettings(patch); await loadSettings(); refreshOverlays(); status('설정을 저장했습니다.');
};
$('layout').onchange = () => { api.saveSettings({ layout: $('layout').value }); refreshOverlays(); };
$('outDirBtn').onclick = async () => { const d = await api.pickOutDir(); if (d) { await api.saveSettings({ outDir: d }); S.outDir = d; $('outDir').textContent = d; } };

// ---------- 1. 영상 ----------
const canAnalyze = () => { $('analyze').disabled = busy || !video || !$('consent').checked; };
$('consent').onchange = canAnalyze;
$('pick').onclick = async () => {
  try {
    const v = await api.pickVideo(); if (!v) return;
    video = v; clips = []; $('clips').innerHTML = ''; $('step2').classList.add('hidden'); $('step3').classList.add('hidden');
    $('videoInfo').textContent = `${v.name} · ${fmt(v.duration)} · ${v.width || '?'}×${v.height || '?'}`;
    status(''); canAnalyze();
  } catch (e) { status(errMsg(e), true); }
};
$('analyze').onclick = async () => {
  busy = true; canAnalyze(); $('bar').style.width = '0';
  status('설교를 살펴보는 중입니다. 창을 닫지 마세요.');
  try {
    const r = await api.analyze({ src: video.src, duration: video.duration });
    clips = r.clips.map(c => ({ ...c, pos: 0.5, captions: null, use: true }));
    $('sermonTitle').textContent = [r.title, r.passage].filter(Boolean).join(' · ');
    renderClips();
    status(`대목 ${clips.length}개를 찾았습니다. 아래에서 다듬어 주세요.`);
    $('step2').classList.remove('hidden'); $('step3').classList.remove('hidden');
    $('step2').scrollIntoView({ behavior: 'smooth' });
  } catch (e) { status(errMsg(e), true); log('실패: ' + errMsg(e)); }
  finally { busy = false; canAnalyze(); $('prog').classList.add('hidden'); }
};

// ---------- 2. 대목 다듬기 ----------
const capsToText = caps => (caps || []).map(c => `${c.s.toFixed(2)} ${c.e.toFixed(2)} ${c.text.replace(/\n/g, ' / ')}`).join('\n');
function textToCaps(t) {
  const out = [];
  for (const line of t.split('\n')) {
    const m = line.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m && +m[2] > +m[1]) out.push({ s: +m[1], e: +m[2], text: m[3].replace(/\s*\/\s*/g, '\n') });
  }
  return out;
}

function renderClips() {
  $('clips').innerHTML = '';
  clips.forEach((c, i) => {
    const el = $('clipTpl').content.firstElementChild.cloneNode(true);
    c.el = el;
    const v = el.querySelector('video');
    v.src = api.fileUrl(video.src) + `#t=${c.start}`;
    el.querySelector('.idx').textContent = `쇼츠 ${i + 1}`;
    el.querySelector('.why').textContent = c.why;
    el.querySelector('.use').onchange = e => { c.use = e.target.checked; };
    const hook = el.querySelector('.hook'); hook.value = c.hook; hook.oninput = () => { c.hook = hook.value; refreshOverlays(); };
    const st = el.querySelector('.start'), en = el.querySelector('.end');
    const showT = () => { st.value = fmt(c.start); en.value = fmt(c.end); el.querySelector('.len').textContent = `${(c.end - c.start).toFixed(1)}초`; };
    const setT = (k, val) => {
      if (!Number.isFinite(val)) return showT();
      c[k] = Math.max(0, Math.min(video.duration, val));
      if (c.end - c.start < 5) c[k === 'start' ? 'start' : 'end'] = k === 'start' ? c.end - 5 : c.start + 5;
      if (c.captions) { c.captions = null; el.querySelector('.caps').classList.add('hidden'); el.querySelector('.capHelp').classList.add('hidden'); log(`쇼츠 ${i + 1}: 구간이 바뀌어 자막을 다시 만들어야 합니다`); }
      showT(); v.currentTime = c.start;
    };
    st.onchange = () => setT('start', parseT(st.value)); en.onchange = () => setT('end', parseT(en.value));
    el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { const [k, d] = b.dataset.d.split(':'); setT(k, c[k] + Number(d)); });
    showT();
    const pos = el.querySelector('.pos'); pos.oninput = () => { c.pos = +pos.value; refreshOverlays(); };
    el.querySelector('.play').onclick = () => {
      if (!v.paused) return v.pause();
      if (v.currentTime < c.start || v.currentTime >= c.end) v.currentTime = c.start;
      v.muted = false; v.play();
    };
    v.ontimeupdate = () => { if (v.currentTime >= c.end) { v.pause(); v.currentTime = c.start; } overlay(c); };
    v.onpause = v.onplay = () => { el.querySelector('.play').textContent = v.paused ? '▶ 미리보기' : '❚❚ 멈춤'; };
    const caps = el.querySelector('.caps');
    caps.oninput = () => { c.captions = textToCaps(caps.value); overlay(c); };
    el.querySelector('.mkCap').onclick = async e => {
      const b = e.target; b.disabled = true; b.textContent = '자막 만드는 중…';
      try {
        c.captions = await api.captions({ src: video.src, start: c.start, end: c.end });
        caps.value = capsToText(c.captions); caps.classList.remove('hidden'); el.querySelector('.capHelp').classList.remove('hidden');
        log(`쇼츠 ${i + 1}: 자막 ${c.captions.length}줄`);
      } catch (err) { log(`쇼츠 ${i + 1} 자막 실패: ${errMsg(err)}`); }
      finally { b.disabled = false; b.textContent = '자막 다시 만들기'; }
    };
    el.querySelector('.mkMeta').onclick = async e => {
      const b = e.target, box = el.querySelector('.meta'); b.disabled = true;
      try {
        const m = await api.meta({ clip: { hook: c.hook, quote: c.quote, captions: c.captions || [] }, church: S.church });
        box.textContent = `제목: ${m.title}\n\n${m.description}\n\n${(m.hashtags || []).join(' ')}`; box.classList.remove('hidden');
      } catch (err) { log(`업로드 문안 실패: ${errMsg(err)}`); }
      finally { b.disabled = false; }
    };
    $('clips').appendChild(el);
  });
  refreshOverlays();
}
function overlay(c) {
  const el = c.el, v = el.querySelector('video'), t = v.currentTime - c.start;
  el.querySelector('.ov-hook').textContent = c.hook;
  el.querySelector('.ov-church').textContent = S.church || '';
  const cap = (c.captions || []).find(x => t >= x.s && t < x.e);
  el.querySelector('.ov-cap').textContent = cap ? cap.text : '';
  const blur = $('layout').value === 'blur';
  el.querySelector('.phone').classList.toggle('blur', blur);
  v.style.objectPosition = `${Math.round(c.pos * 100)}% 50%`;
  el.querySelector('.posWrap').classList.toggle('hidden', blur);
}
const refreshOverlays = () => clips.forEach(overlay);

// ---------- 3. 만들기 ----------
$('render').onclick = async () => {
  const todo = clips.map((c, i) => ({ c, i })).filter(x => x.c.use);
  if (!todo.length) return log('만들 쇼츠를 하나 이상 고르세요');
  const noCap = todo.filter(x => !x.c.captions);
  if (noCap.length && !confirm(`자막이 없는 쇼츠가 ${noCap.length}개 있습니다. 자막 없이 만들까요?`)) return;
  $('render').disabled = true; $('results').innerHTML = '';
  for (const { c, i } of todo) {
    const li = document.createElement('li'); li.textContent = `쇼츠 ${i + 1} 만드는 중…`; $('results').appendChild(li);
    $('bar').style.width = '0';
    try {
      const out = await api.render({ src: video.src, clip: { start: c.start, end: c.end, hook: c.hook, captions: c.captions || [] }, church: S.church, ending: S.ending, layout: $('layout').value, pos: c.pos, withEnding: $('withEnding').checked, outDir: S.outDir, index: i });
      li.textContent = `쇼츠 ${i + 1} 완성 `;
      const b = document.createElement('button'); b.className = 'btn tiny'; b.textContent = '폴더에서 보기'; b.onclick = () => api.reveal(out); li.appendChild(b);
      log(`완성: ${out}`);
    } catch (e) { li.textContent = `쇼츠 ${i + 1} 실패: ${errMsg(e)}`; li.className = 'err'; }
  }
  $('prog').classList.add('hidden'); $('render').disabled = false;
  log('업로드는 직접 해 주세요. 올리기 전에 자막·제목을 한 번 더 확인하세요.');
};

loadSettings();
