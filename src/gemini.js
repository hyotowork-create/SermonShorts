// Gemini 호출(본인 API 키). 설교 음성 전체는 Files API로 올려 대목을 고르고, 대목별 자막은 잘라낸 음성으로 다시 받아 적음
'use strict';
const fs = require('node:fs/promises');
const { parseJson } = require('./lib');

const API = 'https://generativelanguage.googleapis.com';
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash'];

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

function friendly(status, msg) {
  if (status === 400 && /API key/i.test(msg)) return 'Gemini API 키가 맞지 않습니다. 설정에서 키를 확인해 주세요.';
  if (status === 401 || status === 403) return 'Gemini API 키가 맞지 않거나 권한이 없습니다.';
  if (status === 429) return 'Gemini 사용 한도를 넘었습니다. 잠시 뒤 다시 해 주세요.';
  return msg || `Gemini 오류 (HTTP ${status})`;
}

async function call(path, key, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { 'x-goog-api-key': key, ...(init.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(friendly(res.status, j.error?.message), res.status);
  return { res, j };
}

/** 모델을 차례로 시도(없는 모델·과부하면 다음) */
async function generate(key, body, log = () => {}) {
  let last;
  for (const m of MODELS) {
    for (let i = 0; i < 3; i++) {
      try {
        const { j } = await call(`/v1beta/models/${m}:generateContent`, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (!text) throw new ApiError('AI가 빈 응답을 돌려줬습니다', 500);
        return text;
      } catch (e) {
        last = e;
        if (e.status === 404) break;                       // 이 모델 없음 → 다음 모델
        if (![429, 500, 503].includes(e.status)) throw e;
        log(`잠시 뒤 다시 시도합니다 (${e.status})`);
        await new Promise(r => setTimeout(r, 3000 * (i + 1)));
      }
    }
  }
  throw last;
}

/** 음성 파일을 Files API에 올리고 처리 완료까지 기다림 → {uri, mimeType} */
async function upload(key, file, mimeType = 'audio/mpeg', log = () => {}) {
  const buf = await fs.readFile(file);
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': mimeType, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: 'sermon-audio' } }),
  });
  if (!start.ok) { const j = await start.json().catch(() => ({})); throw new ApiError(friendly(start.status, j.error?.message), start.status); }
  const url = start.headers.get('x-goog-upload-url');
  const up = await fetch(url, { method: 'POST', headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: buf });
  const uj = await up.json().catch(() => ({}));
  if (!up.ok) throw new ApiError(friendly(up.status, uj.error?.message), up.status);
  let f = uj.file;
  for (let i = 0; f.state === 'PROCESSING' && i < 60; i++) {
    log('AI가 음성을 받는 중…');
    await new Promise(r => setTimeout(r, 2000));
    f = (await call(`/v1beta/${f.name}`, key)).j;
  }
  if (f.state !== 'ACTIVE') throw new Error('AI가 음성 파일을 처리하지 못했습니다');
  return { uri: f.uri, mimeType: f.mimeType || mimeType };
}

const CLIP_PROMPT = `당신은 교회 설교 영상을 쇼츠(세로 짧은 영상)로 편집하는 편집자입니다. 첨부한 설교 음성을 끝까지 듣고, 쇼츠로 만들 대목을 3~5개 고르세요.
고르는 기준:
- 한 대목은 30~60초. 문장 처음에서 시작해 문장 끝에서 끝나고, 앞뒤 맥락 없이도 뜻이 통하는 완결된 메시지.
- 성경 본문에 근거한 핵심 메시지, 마음을 움직이는 예화·고백, 기억에 남는 한 문장이 있는 곳.
- 빼야 하는 곳: 찬양·노래(저작권), 광고·공지, 헌금, 성도 실명이나 개인 사정이 드러나는 곳, 정치적 발언, 농담만 있는 곳.
- 대목끼리 겹치지 않게.
각 대목마다:
- start, end: 설교 음성 시작부터의 초(소수 첫째 자리까지).
- hook: 쇼츠 위쪽에 띄울 제목. 14자 안팎, 첫 1초에 멈추게 하는 질문이나 핵심 문장. 과장·낚시 금지. 설교 내용에 없는 말 금지.
- why: 이 대목을 고른 이유 한 줄.
- quote: 이 대목의 핵심 문장(설교자가 실제로 한 말 그대로).
JSON만 답하세요: {"title":"설교 제목(알 수 있으면)","passage":"본문(알 수 있으면)","clips":[{"start":0,"end":0,"hook":"","why":"","quote":""}]}`;

const CAPTION_PROMPT = `첨부한 음성은 설교의 한 대목입니다. 들리는 말을 한국어로 빠짐없이 그대로 받아 적어 자막을 만드세요.
- 자막 한 개는 화면에 한 번에 보일 분량: 2~18자 정도, 끊어 읽는 자리에서 나눔. 요약·수정·추가 금지(맞춤법만 바르게).
- s, e: 이 음성 시작부터의 초(소수 둘째 자리). 말과 정확히 맞게.
JSON만 답하세요: {"captions":[{"s":0,"e":0,"text":""}]}`;

const META_PROMPT = (c, church) => `교회 설교 쇼츠의 업로드 문안을 만드세요. 과장·낚시 금지, 설교 내용에 없는 말 금지, 따뜻하고 단정한 존댓말.
교회: ${church || '(미정)'}
쇼츠 제목: ${c.hook}
핵심 문장: ${c.quote}
자막: ${(c.captions || []).map(x => x.text.replace(/\n/g, ' ')).join(' ').slice(0, 1500)}
JSON만 답하세요: {"title":"유튜브 쇼츠 제목 40자 이내(#Shorts 포함)","description":"설명 3~5줄(핵심 메시지 → 교회 소개 한 줄 → '전체 설교는 채널에서')","hashtags":["#설교","…5~8개"]}`;

const JSON_CFG = { responseMimeType: 'application/json', temperature: 0.2 };

async function pickClips(key, audio, log) {
  const text = await generate(key, { contents: [{ role: 'user', parts: [{ file_data: { file_uri: audio.uri, mime_type: audio.mimeType } }, { text: CLIP_PROMPT }] }], generationConfig: JSON_CFG }, log);
  return parseJson(text);
}
async function captions(key, mp3Base64, log) {
  const text = await generate(key, { contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/mpeg', data: mp3Base64 } }, { text: CAPTION_PROMPT }] }], generationConfig: { ...JSON_CFG, temperature: 0 } }, log);
  return parseJson(text);
}
async function metadata(key, clip, church, log) {
  const text = await generate(key, { contents: [{ role: 'user', parts: [{ text: META_PROMPT(clip, church) }] }], generationConfig: { ...JSON_CFG, temperature: 0.5 } }, log);
  return parseJson(text);
}

module.exports = { upload, pickClips, captions, metadata, ApiError };
