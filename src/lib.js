// 순수 함수 모음(네트워크·파일 없음): 자막(ASS)·화면 배치·ffmpeg 인자·Gemini 응답 정리. test/lib.test.js에서 점검
'use strict';

const W = 1080, H = 1920, FPS = 30, ENDING_SEC = 2.5;

/** ffmpeg -i 의 stderr에서 길이(초)와 영상 크기 */
function parseProbe(stderr) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const v = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : null,
    width: v ? +v[1] : null, height: v ? +v[2] : null,
    hasAudio: /Stream #.*Audio:/.test(stderr),
  };
}

/** 진행률: stderr 한 덩어리에서 마지막 time= */
function parseTime(chunk) {
  const all = [...String(chunk).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round2 = x => Math.round(x * 100) / 100;

/** Gemini가 고른 대목 정리: 숫자 보정, 30~75초 범위, 영상 길이 안, 겹치면 뒤의 것 버림 */
function normalizeClips(raw, duration) {
  const list = Array.isArray(raw?.clips) ? raw.clips : [];
  const out = [];
  for (const c of list) {
    let s = Number(c.start), e = Number(c.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    s = clamp(s, 0, duration || s); e = clamp(e, 0, duration || e);
    if (e - s < 15) continue;
    if (e - s > 75) e = s + 75;
    if (out.some(o => s < o.end && e > o.start)) continue;
    out.push({ start: round2(s), end: round2(e), hook: String(c.hook || '').trim().slice(0, 30), why: String(c.why || '').trim(), quote: String(c.quote || '').trim() });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 자막 정리: 클립 길이 안, 시간순, 빈 글자 제거, 한 줄 18자 넘으면 두 줄로 */
function normalizeCaptions(raw, clipLen) {
  const list = Array.isArray(raw?.captions) ? raw.captions : [];
  return list
    .map(c => ({ s: round2(clamp(Number(c.s), 0, clipLen)), e: round2(clamp(Number(c.e), 0, clipLen)), text: wrap(String(c.text || '').trim()) }))
    .filter(c => c.text && Number.isFinite(c.s) && Number.isFinite(c.e) && c.e > c.s)
    .sort((a, b) => a.s - b.s);
}

/** 한 줄이 길면 가운데쯤 띄어쓰기에서 나눔(최대 두 줄) */
function wrap(text, max = 18) {
  const t = text.replace(/\s+/g, ' ');
  if (t.length <= max || t.includes('\n')) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? t : t.slice(0, best) + '\n' + t.slice(best + 1);
}

// ASS 시각 h:mm:ss.cc
function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
// ASS 글자: 중괄호(꾸밈 명령)·역슬래시 막기, 줄바꿈은 \N
const assText = s => String(s).replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N');

/**
 * 쇼츠 한 편의 자막 파일. 제목은 클립 내내 위쪽, 자막은 아래쪽(쇼츠 버튼에 안 가리게), 끝에 교회 안내 장면
 * opt: {clipLen, hook, captions:[{s,e,text}], church, ending, endingSec}
 */
function buildAss({ clipLen, hook = '', captions = [], church = '', ending = '', endingSec = ENDING_SEC }) {
  const total = clipLen + (endingSec || 0);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Pretendard ExtraBold,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,6,2,2,70,70,560,1
Style: Hook,Pretendard ExtraBold,80,&H004BC2FF,&H004BC2FF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,6,2,8,70,70,250,1
Style: Church,Pretendard Bold,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,4,1,8,70,70,170,1
Style: EndBig,Pretendard ExtraBold,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,80,80,0,1
Style: EndSmall,Pretendard Bold,46,&H004BC2FF,&H004BC2FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = [];
  const fadeIn = '{\\fad(250,0)}';
  if (church) ev.push(`Dialogue: 1,${assTime(0)},${assTime(clipLen)},Church,,0,0,0,,${assText(church)}`);
  if (hook) ev.push(`Dialogue: 1,${assTime(0)},${assTime(clipLen)},Hook,,0,0,0,,${fadeIn}${assText(wrap(hook, 14))}`);
  for (const c of captions) ev.push(`Dialogue: 0,${assTime(c.s)},${assTime(Math.min(c.e, clipLen))},Caption,,0,0,0,,${assText(c.text)}`);
  if (endingSec) {
    if (church) ev.push(`Dialogue: 0,${assTime(clipLen)},${assTime(total)},EndBig,,0,0,0,,${fadeIn}{\\pos(540,880)}${assText(church)}`);
    if (ending) ev.push(`Dialogue: 0,${assTime(clipLen)},${assTime(total)},EndSmall,,0,0,0,,${fadeIn}{\\pos(540,1040)}${assText(wrap(ending, 20))}`);
  }
  return head + ev.join('\n') + '\n';
}

/** 가로 영상 → 세로 1080×1920. fill: 꽉 채워 자르기(pos 0~1 = 왼쪽~오른쪽), blur: 가운데 영상 + 흐린 배경 */
function layoutFilter(layout, pos = 0.5) {
  const p = clamp(Number(pos) || 0.5, 0, 1).toFixed(3);
  if (layout === 'blur') {
    return `split=2[bg][fg];[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.12[bgb];`
      + `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2-60`;
  }
  return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)*${p}:(ih-oh)/2`;
}

/**
 * 렌더 명령 인자. ffmpeg는 작업 폴더(cwd)에서 돌리고 자막·글꼴은 상대 경로(윈도 경로의 콜론 문제 피함)
 * opt: {src, start, end, layout, pos, ending:boolean, out}
 */
function renderArgs({ src, start, end, layout = 'fill', pos = 0.5, ending = true, out }) {
  const len = round2(end - start);
  const inputs = ['-y', '-ss', String(start), '-t', String(len), '-i', src];
  let fc = `[0:v]${layoutFilter(layout, pos)},fps=${FPS},setsar=1[v0];[0:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a0];`;
  if (ending) {
    inputs.push('-f', 'lavfi', '-t', String(ENDING_SEC), '-i', `color=c=0x0e1230:s=${W}x${H}:r=${FPS}`,
      '-f', 'lavfi', '-t', String(ENDING_SEC), '-i', 'anullsrc=r=48000:cl=stereo');
    fc += `[1:v]setsar=1[v1];[v0][a0][v1][2:a]concat=n=2:v=1:a=1[vc][ac];[vc]subtitles=clip.ass:fontsdir=fonts,format=yuv420p[vo]`;
  } else {
    fc += `[v0]subtitles=clip.ass:fontsdir=fonts,format=yuv420p[vo];[a0]anull[ac]`;
  }
  return [...inputs, '-filter_complex', fc, '-map', '[vo]', '-map', '[ac]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
}

/** 분석용 음성 추출(모노 16kHz, 작게) */
const audioArgs = ({ src, out, start, len }) => ['-y', ...(start != null ? ['-ss', String(start), '-t', String(len)] : []), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out];

const safeName = s => String(s || 'sermon').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'sermon';

/** Gemini 응답 글자에서 JSON 꺼내기(코드 울타리·앞뒤 말 허용) */
function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('AI 응답에서 결과를 찾지 못했습니다');
  return JSON.parse(t.slice(a, b + 1));
}

module.exports = { W, H, FPS, ENDING_SEC, parseProbe, parseTime, normalizeClips, normalizeCaptions, wrap, assTime, assText, buildAss, layoutFilter, renderArgs, audioArgs, safeName, parseJson };
