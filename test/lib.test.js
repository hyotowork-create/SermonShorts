'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib');

test('parseProbe: 길이·크기·소리', () => {
  const s = 'Duration: 00:41:12.50, start: 0\n  Stream #0:0: Video: h264, yuv420p, 1920x1080 [SAR 1:1], 30 fps\n  Stream #0:1: Audio: aac';
  assert.deepEqual(L.parseProbe(s), { duration: 2472.5, width: 1920, height: 1080, hasAudio: true });
});

test('normalizeClips: 겹침·너무 짧음·너무 긺·범위 밖', () => {
  const r = L.normalizeClips({ clips: [
    { start: 100, end: 150, hook: 'A' }, { start: 120, end: 170, hook: '겹침' }, { start: 10, end: 20, hook: '짧음' },
    { start: 300, end: 500, hook: '긺' }, { start: 'x', end: 5 }, { start: 2400, end: 2600, hook: '끝' },
  ] }, 2472.5);
  assert.deepEqual(r.map(c => [c.start, c.end, c.hook]), [[100, 150, 'A'], [300, 375, '긺'], [2400, 2472.5, '끝']]);
});

test('normalizeCaptions·wrap: 범위·순서·긴 줄 나눔', () => {
  const r = L.normalizeCaptions({ captions: [{ s: 5, e: 7, text: '둘째' }, { s: 0, e: 2, text: '하나님은 오늘도 우리를 부르고 계십니다' }, { s: 3, e: 3, text: '빈 길이' }, { s: 50, e: 60, text: '밖' }] }, 40);
  assert.equal(r.length, 2); // 길이 0(3~3, 범위 밖 50~60) 걸러짐
  assert.equal(r[0].text, '하나님은 오늘도 우리를\n부르고 계십니다'); // 가운데에 가장 가까운 띄어쓰기
  assert.equal(r[1].text, '둘째');
});

test('buildAss: 시간·특수문자·끝 장면', () => {
  const a = L.buildAss({ clipLen: 30, hook: '{위험}', captions: [{ s: 1, e: 2.5, text: '첫 줄\n둘째 줄' }], church: '동역교회', ending: '주일 11시' });
  assert.match(a, /Dialogue: 0,0:00:01\.00,0:00:02\.50,Caption,,0,0,0,,첫 줄\\N둘째 줄/);
  assert.match(a, /Hook,,0,0,0,,\{\\fad\(250,0\)\}｛위험｝/);
  assert.match(a, /0:00:30\.00,0:00:32\.50,EndBig/);
  assert.equal(L.assTime(3725.456), '1:02:05.46');
});

test('renderArgs: 끝 장면 있음/없음, 위치 범위', () => {
  const a = L.renderArgs({ src: '/v.mp4', start: 10, end: 40, layout: 'fill', pos: 2, ending: true, out: '/o.mp4' });
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.match(fc, /crop=1080:1920:\(iw-ow\)\*1\.000/);
  assert.match(fc, /concat=n=2:v=1:a=1/);
  assert.equal(a[a.indexOf('-t') + 1], '30');
  const b = L.renderArgs({ src: '/v.mp4', start: 0, end: 30, layout: 'blur', ending: false, out: '/o.mp4' });
  assert.doesNotMatch(b.join(' '), /concat|lavfi/);
  assert.match(b[b.indexOf('-filter_complex') + 1], /boxblur/);
});

test('parseJson: 코드 울타리 허용', () => {
  assert.deepEqual(L.parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => L.parseJson('없음'));
});
