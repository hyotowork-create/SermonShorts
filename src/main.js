// Sermon Shorts 본체: 창, 파일 고르기, ffmpeg 실행, Gemini 호출, 설정(키는 운영체제 보안 저장소로 암호화)
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const L = require('./lib');
const G = require('./gemini');

const MOCK = process.env.SERMON_SHORTS_MOCK === '1'; // AI를 부르지 않고 가짜 결과로 화면·렌더 점검
// asar 안의 실행 파일은 못 돌리므로 언팩 경로로 바꿈
const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const FONTS = path.join(__dirname, '..', 'resources', 'fonts'); // asar 안에서도 읽힘(렌더 때 작업 폴더로 복사)

let win;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

async function readSettings() {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')); } catch { return {}; }
}
async function writeSettings(s) { await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2)); }
async function getKey() {
  const s = await readSettings();
  if (!s.keyEnc) return '';
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(s.keyEnc, 'base64')) : Buffer.from(s.keyEnc, 'base64').toString(); } catch { return ''; }
}

const send = (ch, payload) => win?.webContents.send(ch, payload);
const log = msg => send('log', msg);

/** ffmpeg 실행. onTime(초)으로 진행률 */
function ffmpeg(args, { cwd, onTime } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', ...args], { cwd });
    let err = '';
    p.stderr.on('data', d => { const s = d.toString(); err = (err + s).slice(-8000); const t = L.parseTime(s); if (t != null) onTime?.(t); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error('영상 처리에 실패했습니다: ' + err.split('\n').filter(Boolean).slice(-3).join(' / '))));
  });
}
async function probe(src) {
  const err = await new Promise(resolve => { const p = spawn(FFMPEG, ['-hide_banner', '-i', src]); let e = ''; p.stderr.on('data', d => e += d); p.on('close', () => resolve(e)); p.on('error', () => resolve(e)); });
  return L.parseProbe(err);
}
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'sermon-shorts-'));

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 680, backgroundColor: '#0e1230', title: 'Sermon Shorts',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- 설정 ----------
ipcMain.handle('settings:get', async () => {
  const s = await readSettings();
  return { church: s.church || '', ending: s.ending || '', layout: s.layout || 'fill', hasKey: !!s.keyEnc, mock: MOCK, outDir: s.outDir || app.getPath('videos') };
});
ipcMain.handle('settings:set', async (_e, patch) => {
  const s = await readSettings();
  for (const k of ['church', 'ending', 'layout', 'outDir']) if (typeof patch[k] === 'string') s[k] = patch[k].slice(0, 200);
  if (typeof patch.key === 'string') {
    const k = patch.key.trim();
    s.keyEnc = !k ? '' : (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : Buffer.from(k)).toString('base64');
  }
  await writeSettings(s);
  return true;
});

// ---------- 영상 고르기 ----------
ipcMain.handle('video:pick', async () => {
  let src = MOCK && process.env.SERMON_SHORTS_VIDEO; // 시험 모드 전용: 고르기 창 없이 시험 영상
  if (!src) {
    const r = await dialog.showOpenDialog(win, { title: '설교 영상 고르기', properties: ['openFile'], filters: [{ name: '영상', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    src = r.filePaths[0];
  }
  const info = await probe(src);
  if (!info.duration) throw new Error('이 파일의 길이를 읽지 못했습니다. 다른 영상 파일로 해 주세요.');
  if (!info.hasAudio) throw new Error('이 영상에는 소리가 없습니다.');
  return { src, name: path.basename(src), ...info };
});
ipcMain.handle('outdir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '완성 영상을 저장할 폴더', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- 분석: 좋은 대목 고르기 ----------
ipcMain.handle('analyze', async (_e, { src, duration }) => {
  if (MOCK) {
    log('(시험 모드) 가짜 대목을 만듭니다');
    const n = Math.max(1, Math.min(3, Math.floor(duration / 45)));
    return { title: '시험 설교', passage: '', clips: L.normalizeClips({ clips: Array.from({ length: n }, (_, i) => ({ start: i * 45 + 2, end: i * 45 + 40, hook: `시험 대목 ${i + 1}: 지금 이 순간도`, why: '시험', quote: '시험 문장' })) }, duration) };
  }
  const key = await getKey();
  if (!key) throw new Error('먼저 설정에서 Gemini API 키를 넣어 주세요.');
  const dir = await tmpDir();
  try {
    log('설교 음성을 뽑는 중…');
    const mp3 = path.join(dir, 'audio.mp3');
    await ffmpeg(L.audioArgs({ src, out: mp3 }), { onTime: t => send('progress', { stage: 'audio', ratio: t / duration }) });
    log('AI에 음성을 보내는 중…');
    const audio = await G.upload(key, mp3, 'audio/mpeg', log);
    log('AI가 설교를 듣고 대목을 고르는 중… (설교 길이에 따라 1~3분)');
    const raw = await G.pickClips(key, audio, log);
    const clips = L.normalizeClips(raw, duration);
    if (!clips.length) throw new Error('쇼츠로 만들 대목을 찾지 못했습니다. 설교 부분만 있는 영상으로 다시 해 보세요.');
    return { title: String(raw.title || ''), passage: String(raw.passage || ''), clips };
  } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

// ---------- 대목 자막 ----------
ipcMain.handle('captions', async (_e, { src, start, end }) => {
  const len = end - start;
  if (MOCK) {
    const out = [];
    for (let t = 0; t < len - 1; t += 3) out.push({ s: t, e: Math.min(len, t + 2.8), text: `시험 자막 ${out.length + 1} 하나님은 지금도 일하십니다` });
    return L.normalizeCaptions({ captions: out }, len);
  }
  const key = await getKey();
  if (!key) throw new Error('먼저 설정에서 Gemini API 키를 넣어 주세요.');
  const dir = await tmpDir();
  try {
    const mp3 = path.join(dir, 'seg.mp3');
    await ffmpeg(L.audioArgs({ src, out: mp3, start, len }));
    const b64 = (await fs.readFile(mp3)).toString('base64');
    return L.normalizeCaptions(await G.captions(key, b64, log), len);
  } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

// ---------- 업로드 문안 ----------
ipcMain.handle('meta', async (_e, { clip, church }) => {
  if (MOCK) return { title: `${clip.hook} #Shorts`, description: '(시험 모드) 설명 초안', hashtags: ['#설교', '#쇼츠'] };
  const key = await getKey();
  if (!key) throw new Error('먼저 설정에서 Gemini API 키를 넣어 주세요.');
  return G.metadata(key, clip, church, log);
});

// ---------- 렌더 ----------
ipcMain.handle('render', async (_e, { src, clip, church, ending, layout, pos, withEnding, outDir, index }) => {
  const dir = await tmpDir();
  try {
    await fs.mkdir(path.join(dir, 'fonts'));
    for (const f of await fs.readdir(FONTS)) if (f.endsWith('.otf')) await fs.copyFile(path.join(FONTS, f), path.join(dir, 'fonts', f));
    const clipLen = clip.end - clip.start;
    await fs.writeFile(path.join(dir, 'clip.ass'), L.buildAss({ clipLen, hook: clip.hook, captions: clip.captions || [], church, ending, endingSec: withEnding ? L.ENDING_SEC : 0 }));
    await fs.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, `${L.safeName(church || 'Sermon')}_쇼츠${index + 1}_${L.safeName(clip.hook).slice(0, 30)}.mp4`);
    const total = clipLen + (withEnding ? L.ENDING_SEC : 0);
    await ffmpeg(L.renderArgs({ src, start: clip.start, end: clip.end, layout, pos, ending: withEnding, out }), { cwd: dir, onTime: t => send('progress', { stage: 'render', index, ratio: t / total }) });
    return out;
  } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('open-url', (_e, url) => { if (/^https:\/\/(aistudio\.google\.com|github\.com|hyotowork-create\.github\.io)\//.test(url)) shell.openExternal(url); });
