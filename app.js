(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trim = s => String(s ?? '').trim();
const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const CFG = window.CA_CONFIG || {};
const LIVE = !!(CFG.supabaseUrl && CFG.supabaseKey && !/CHANGE_ME/.test(CFG.supabaseUrl + CFG.supabaseKey));
const DB_LIMIT = 500 * 1024 * 1024;
const VOICE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_PC = '#8c8577';
const GROUPS = ['커뮤니티', '자캐연합'];

const ERR = {
  invalid_password: '편집 비밀번호가 맞지 않아요.',
  name_required: '이름을 적어 주세요.',
  portrait_required: '두상 이미지를 올려 주세요.',
  not_found: '이 캐릭터를 찾을 수 없어요. 이미 삭제되었을 수 있어요.',
  too_large: '파일이 너무 커요. 보이스는 2MB까지 올릴 수 있어요.',
  bad_type: '이미지나 오디오 파일만 올릴 수 있어요.',
  bad_payload: '파일을 읽지 못했어요. 다른 파일로 다시 시도해 주세요.'
};
function errText(e) {
  const m = String((e && e.message) || e);
  for (const k in ERR) if (m.includes(k)) return ERR[k];
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return '서버에 연결하지 못했어요. 인터넷 연결과 Supabase 프로젝트가 켜져 있는지 확인해 주세요.';
  return '문제가 생겼어요. ' + m;
}
const isAuthErr = e => String(e && e.message).includes('invalid_password');

function liveStore() {
  const base = CFG.supabaseUrl.replace(/\/+$/, '');
  const headers = json => {
    const h = { apikey: CFG.supabaseKey };
    if (CFG.supabaseKey.startsWith('eyJ')) h.Authorization = 'Bearer ' + CFG.supabaseKey;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };
  async function req(path, opts = {}) {
    const r = await fetch(base + path, { ...opts, headers: headers(!!opts.body) });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) throw new Error((body && (body.message || body.error || body.hint)) || ('HTTP ' + r.status));
    return body;
  }
  async function chunked(ids, size, cols) {
    const out = [];
    for (let i = 0; i < ids.length; i += size) {
      const part = ids.slice(i, i + size);
      const rows = await req(`/rest/v1/media?select=${cols}&id=in.(${part.join(',')})`);
      out.push(...rows);
    }
    return out;
  }
  return {
    list: () => req('/rest/v1/characters?select=id,data,sort_order&order=sort_order.asc,created_at.asc'),
    async media(ids) {
      const out = {};
      (await chunked(ids, 30, 'id,data')).forEach(r => { out[r.id] = r.data; });
      return out;
    },
    mediaFull: ids => chunked(ids, 8, 'id,mime,data'),
    mediaIndex: () => req('/rest/v1/media?select=id,mime,bytes&order=created_at.asc'),
    rpc: (fn, args) => req('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) })
  };
}

function demoStore() {
  const chars = [];
  const media = new Map();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const put = (data, mime) => { const id = uid(); media.set(id, { mime, data }); return id; };
  const need = pw => { if (pw !== 'demo') throw new Error('invalid_password'); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clone = o => JSON.parse(JSON.stringify(o));
  seedDemo(chars, put);
  const refs = () => chars.map(c => JSON.stringify(c.data)).join(' ');
  const fns = {
    check_password: ({ pw }) => pw === 'demo',
    upload_media({ pw, mime, payload }) {
      need(pw);
      if (!/^(image|audio)\//.test(mime || '')) throw new Error('bad_type');
      if (String(payload).length > 3000000) throw new Error('too_large');
      return put(payload, mime);
    },
    save_character({ pw, cid, cdata }) {
      need(pw);
      if (!trim(cdata.name)) throw new Error('name_required');
      if (!(cdata.portrait && cdata.portrait.img)) throw new Error('portrait_required');
      if (!cid) {
        const id = uid();
        chars.push({ id, data: clone(cdata), sort_order: Math.max(0, ...chars.map(c => c.sort_order)) + 1 });
        return id;
      }
      const c = chars.find(x => x.id === cid);
      if (!c) throw new Error('not_found');
      c.data = clone(cdata);
      return cid;
    },
    delete_character({ pw, cid }) {
      need(pw);
      const i = chars.findIndex(c => c.id === cid);
      if (i < 0) throw new Error('not_found');
      const old = JSON.stringify(chars[i].data);
      chars.splice(i, 1);
      const r = refs();
      [...media.keys()].forEach(id => { if (old.includes(id) && !r.includes(id)) media.delete(id); });
    },
    reorder_characters({ pw, ids }) {
      need(pw);
      ids.forEach((id, i) => { const c = chars.find(x => x.id === id); if (c) c.sort_order = i + 1; });
    },
    storage_usage({ pw }) {
      need(pw);
      let mb = 0;
      media.forEach(m => { mb += m.data.length; });
      return { database_bytes: mb + JSON.stringify(chars).length + 8000000, media_bytes: mb, media_count: media.size, character_count: chars.length };
    },
    restore_media({ pw, mid, mime, payload }) { need(pw); media.set(mid, { mime, data: payload }); },
    restore_character({ pw, cid, cdata, csort }) {
      need(pw);
      const c = chars.find(x => x.id === cid);
      if (c) { c.data = clone(cdata); c.sort_order = csort; } else chars.push({ id: cid, data: clone(cdata), sort_order: csort });
    }
  };
  return {
    async list() { await wait(120); return clone(chars).sort((a, b) => a.sort_order - b.sort_order); },
    async media(ids) { const out = {}; ids.forEach(id => { if (media.has(id)) out[id] = media.get(id).data; }); return out; },
    async mediaFull(ids) { return ids.filter(id => media.has(id)).map(id => ({ id, ...media.get(id) })); },
    async mediaIndex() { return [...media.entries()].map(([id, m]) => ({ id, mime: m.mime, bytes: m.data.length })); },
    async rpc(fn, args) {
      await wait(fn === 'check_password' && args.pw !== 'demo' ? 500 : 160);
      return fns[fn](args);
    }
  };
}

function svgData(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
function demoBust(pc, hair, skin) {
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${pc}" opacity=".28"/><g fill="${pc}" opacity=".18">${[0, 1, 2, 3, 4, 5, 6].map(i => `<rect x="${i * 34 - 40}" y="-20" width="10" height="260" transform="rotate(-35 100 100)"/>`).join('')}</g><path d="M30 200c6-44 34-62 70-62s64 18 70 62z" fill="${hair}" opacity=".85"/><path d="M52 200c4-30 22-46 48-46s44 16 48 46z" fill="#fffcf2"/><circle cx="100" cy="92" r="40" fill="${skin}"/><path d="M58 92c0-30 18-50 42-50s44 18 44 48c-10-14-26-22-44-24-14 6-28 14-42 26z" fill="${hair}"/><circle cx="86" cy="98" r="3.4" fill="#23201b"/><circle cx="114" cy="98" r="3.4" fill="#23201b"/><path d="M93 114q7 5 14 0" stroke="#23201b" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>`);
}
function demoFull(pc, hair, skin) {
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 560"><ellipse cx="150" cy="546" rx="90" ry="10" fill="#23201b" opacity=".12"/><path d="M104 530l10-170h72l10 170h-30l-14-140-14 140z" fill="#3a3a44"/><path d="M84 210c6-40 30-58 66-58s60 18 66 58l14 170H70z" fill="${pc}"/><path d="M120 152h60l-30 60z" fill="#fffcf2"/><path d="M70 220l-26 150 22 6 30-130zM230 220l26 150-22 6-30-130z" fill="${pc}" opacity=".85"/><circle cx="150" cy="104" r="46" fill="${skin}"/><path d="M102 106c0-36 20-58 48-58s50 22 50 56c-14-18-32-26-50-28-16 8-32 18-48 30z" fill="${hair}"/><path d="M196 96c14 30 10 70-4 92 2-30-2-56-12-74z" fill="${hair}"/><circle cx="134" cy="112" r="3.6" fill="#23201b"/><circle cx="166" cy="112" r="3.6" fill="#23201b"/><path d="M142 130q8 5 16 0" stroke="#23201b" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`);
}
function demoChime() {
  const rate = 16000, secs = 0.9, n = Math.floor(rate * secs);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  w(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate, f = t < 0.3 ? 660 : t < 0.6 ? 880 : 990;
    const env = Math.exp(-((t % 0.3) * 9)) * 0.35;
    buf.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * env * 32767, true);
  }
  let bin = '';
  new Uint8Array(buf.buffer).forEach(b => { bin += String.fromCharCode(b); });
  return 'data:audio/wav;base64,' + btoa(bin);
}
function seedDemo(chars, put) {
  const bust = (pc, h, s) => { const d = demoBust(pc, h, s); return { img: put(d, 'image/svg+xml'), thumb: put(d, 'image/svg+xml') }; };
  const a = 'demo-yoonseul', b = 'demo-dano', c = 'demo-kyle', d = 'demo-mia';
  chars.push(
    { id: a, sort_order: 1, data: {
      name: '윤슬', alt_names: [{ label: '한자', value: '尹瑟' }, { label: '영어', value: 'Yoon Seul' }],
      portrait: bust('#6f8fb8', '#2f3550', '#f4dccb'), full: put(demoFull('#6f8fb8', '#2f3550', '#f4dccb'), 'image/svg+xml'),
      quote: { text: '오늘도 음악실 열쇠는 제가 먼저 받아 갈게요.\n…늦잠 잔 거 아니에요, 진짜로.', voice: put(demoChime(), 'audio/wav'), cv: '미정' },
      age: '17', gender: '여', height: '162', body: '마른 편', birthday: '4월 2일', job: '고등학생, 피아노부 부장', species: '인간',
      world: '청명 학원', group: '커뮤니티', point_color: '#6f8fb8',
      keywords: ['차분함', '완벽주의', '은근한 허당'],
      personality_text: '말수는 적지만 맡은 일은 끝까지 해낸다. 칭찬을 들으면 표정 관리를 못 해서 고개를 돌려 버린다.',
      features: '매일 아침 수업 전에 음악실에서 피아노를 친다. 악보 귀퉁이에 작은 고양이 낙서를 남기는 버릇이 있다.',
      past: '',
      relations: [{ char_id: b, label: '소꿉친구', desc: '아침마다 운동장에서 마주친다. 서로 상대가 먼저 인사하길 기다린다.' }]
    } },
    { id: b, sort_order: 2, data: {
      name: '단오', alt_names: [{ label: '영어', value: 'Dano' }],
      portrait: bust('#c9a227', '#5a3b22', '#f1d2b6'),
      quote: { text: '한 바퀴만 더! 진짜 마지막!', voice: '', cv: '' },
      age: '18', gender: '남', height: '178', body: '탄탄한 편', job: '고등학생, 육상부', world: '청명 학원', group: '커뮤니티', point_color: '#c9a227',
      keywords: ['직진', '밝음'], personality_text: '',
      features: '새벽 운동장을 제일 먼저 뛰는 사람. 음악실 창문 아래를 지나갈 때만 속도가 느려진다.',
      past: '', relations: [{ char_id: a, label: '소꿉친구', desc: '' }]
    } },
    { id: c, sort_order: 3, data: {
      name: '카일 렌', alt_names: [{ label: '원문', value: 'Kyle Wren' }],
      portrait: bust('#3f7d6b', '#c9c2b0', '#e8c9ae'),
      quote: { text: '바람 방향이 바뀌었어. 닻 올려.', voice: '', cv: '' },
      age: '31', gender: '남', height: '185', job: '쇄빙선 항해사', species: '인간', world: '북방 항로', group: '자캐연합', point_color: '#3f7d6b',
      keywords: ['무뚝뚝함', '책임감'], personality_text: '필요한 말만 한다. 대신 한 말은 지킨다.',
      features: '', past: '얼어붙은 항구에서 자랐다. 첫 항해에서 잃은 나침반을 아직 찾고 있다.',
      relations: [{ char_id: '', name: '선장 오르테가', label: '상관', desc: '친구 캐릭터. 카일을 배에 태운 사람.' }]
    } },
    { id: d, sort_order: 4, data: { name: '미아', portrait: bust(DEFAULT_PC, '#7c766b', '#f2dcc8') } }
  );
}

const store = LIVE ? liveStore() : demoStore();
const api = {
  list: () => store.list(),
  media: ids => store.media(ids),
  mediaFull: ids => store.mediaFull(ids),
  mediaIndex: () => store.mediaIndex(),
  checkPw: pw => store.rpc('check_password', { pw }),
  upload: (pw, mime, payload) => store.rpc('upload_media', { pw, mime, payload }),
  save: (pw, cid, cdata) => store.rpc('save_character', { pw, cid, cdata }),
  remove: (pw, cid) => store.rpc('delete_character', { pw, cid }),
  reorder: (pw, ids) => store.rpc('reorder_characters', { pw, ids }),
  usage: pw => store.rpc('storage_usage', { pw }),
  restoreMedia: (pw, mid, mime, payload) => store.rpc('restore_media', { pw, mid, mime, payload }),
  restoreChar: (pw, cid, cdata, csort) => store.rpc('restore_character', { pw, cid, cdata, csort })
};

let chars = null;
let loadError = null;
let editMode = false;
let pw = null;
let listQ = '';
let typeTimer = null;
let audio = null;
const mcache = new Map();

try {
  pw = sessionStorage.getItem('ca_pw');
  editMode = !!pw && sessionStorage.getItem('ca_edit') === '1';
} catch { pw = null; }

function remember() {
  try {
    if (pw) sessionStorage.setItem('ca_pw', pw); else sessionStorage.removeItem('ca_pw');
    sessionStorage.setItem('ca_edit', editMode ? '1' : '0');
  } catch { }
}
function forget() { pw = null; remember(); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function validHex(h) { return /^#[0-9a-f]{6}$/i.test(h || '') ? h : DEFAULT_PC; }
function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return L > 0.42 ? '#23201b' : '#ffffff';
}
function pcStyle(d) { const pc = validHex(d && d.point_color); return `--pc:${pc};--pc-ink:${inkFor(pc)}`; }
const thumbOf = d => (d.portrait && (d.portrait.thumb || d.portrait.img)) || '';
const byId = id => (chars || []).find(c => c.id === id);
const fmtHeight = h => /^\d+(\.\d+)?$/.test(trim(h)) ? trim(h) + 'cm' : trim(h);
const mb = n => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + 'MB';

async function hydrate(root) {
  const els = $$('img[data-media]', root);
  const want = [...new Set(els.map(e => e.dataset.media).filter(id => id && !mcache.has(id)))];
  if (want.length) {
    try {
      const got = await api.media(want);
      want.forEach(id => mcache.set(id, got[id] || ''));
    } catch { }
  }
  els.forEach(e => { const s = mcache.get(e.dataset.media); if (s) e.src = s; });
}
async function mediaSrc(id) {
  if (!id) return '';
  if (!mcache.has(id)) {
    const got = await api.media([id]);
    mcache.set(id, got[id] || '');
  }
  return mcache.get(id);
}

function gate() {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h2 id="gate-title">편집 모드</h2>
      <p>편집 비밀번호를 입력하면 캐릭터를 등록하고 고칠 수 있어요.</p>
      <input class="input" type="password" id="gate-pw" autocomplete="current-password" aria-label="편집 비밀번호" required>
      <p class="status error" id="gate-err" hidden></p>
      <div class="row-btns"><button type="button" class="btn ghost" id="gate-cancel">취소</button><button class="btn solid" id="gate-ok">확인</button></div>
    </form>`;
    document.body.appendChild(back);
    const input = $('#gate-pw', back);
    const close = ok => { back.remove(); document.removeEventListener('keydown', onKey); resolve(ok); };
    const onKey = e => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', e => { if (e.target === back) close(false); });
    $('#gate-cancel', back).onclick = () => close(false);
    $('form', back).onsubmit = async e => {
      e.preventDefault();
      const v = input.value;
      const ok = $('#gate-ok', back);
      const err = $('#gate-err', back);
      ok.disabled = true; ok.textContent = '확인 중…'; err.hidden = true;
      try {
        if (await api.checkPw(v)) { pw = v; remember(); close(true); return; }
        err.textContent = '비밀번호가 맞지 않아요. 다시 입력해 주세요.';
      } catch (ex) { err.textContent = errText(ex); }
      err.hidden = false; ok.disabled = false; ok.textContent = '확인';
      input.select();
    };
    setTimeout(() => input.focus(), 30);
  });
}
async function ensurePw() { return pw ? true : gate(); }

function renderTop() {
  const n = $('#top-actions');
  if (editMode) {
    n.innerHTML = `<a class="btn solid" href="#/new">새 캐릭터</a><a class="btn" href="#/manage">관리</a><button class="btn ghost" id="exit-edit" type="button">편집 끝내기</button>`;
    $('#exit-edit').onclick = () => { editMode = false; remember(); if (/^#\/(new|edit|manage)/.test(location.hash)) location.hash = '#/'; else render(); };
  } else {
    n.innerHTML = `<button class="btn" id="enter-edit" type="button">편집 모드</button>`;
    $('#enter-edit').onclick = async () => { if (await ensurePw()) { editMode = true; remember(); toast('편집 모드를 켰어요.'); render(); } };
  }
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'c' && parts[1]) return { v: 'detail', id: parts[1] };
  if (parts[0] === 'edit' && parts[1]) return { v: 'edit', id: parts[1] };
  if (parts[0] === 'new') return { v: 'edit', id: null };
  if (parts[0] === 'manage') return { v: 'manage' };
  return { v: 'list' };
}

async function load() {
  try { chars = await api.list(); loadError = null; }
  catch (e) { chars = null; loadError = e; }
}

function stopMedia() {
  clearInterval(typeTimer); typeTimer = null;
  if (audio) { audio.pause(); audio = null; }
}

async function render() {
  stopMedia();
  renderTop();
  const main = $('#main');
  const r = route();
  if (!chars && !loadError) {
    main.innerHTML = `<div class="grid" aria-hidden="true">${'<div class="skeleton"></div>'.repeat(6)}</div>`;
    await load();
  }
  if (loadError) {
    main.innerHTML = `<div class="empty"><strong>목록을 불러오지 못했어요</strong><span>${esc(errText(loadError))}</span><button class="btn" id="retry" type="button">다시 불러오기</button></div>`;
    $('#retry').onclick = () => { loadError = null; render(); };
    return;
  }
  if ((r.v === 'edit' || r.v === 'manage') && !editMode) {
    if (!(await ensurePw())) { location.hash = r.id ? '#/c/' + r.id : '#/'; return; }
    editMode = true; remember(); renderTop();
  }
  main.classList.remove('view-in');
  void main.offsetWidth;
  main.classList.add('view-in');
  if (r.v === 'detail') renderDetail(main, r.id);
  else if (r.v === 'edit') renderEdit(main, r.id);
  else if (r.v === 'manage') renderManage(main);
  else renderList(main);
  window.scrollTo(0, 0);
}

function searchFields(d) {
  const f = [['이름', d.name]];
  (d.alt_names || []).forEach(a => f.push([a.label || '다른 표기', a.value]));
  [['age', '나이'], ['gender', '성별'], ['height', '키'], ['body', '체형'], ['birthday', '생일'], ['job', '직업'], ['species', '종족'], ['world', '세계관'], ['group', '소속']]
    .forEach(([k, l]) => f.push([l, d[k]]));
  (d.keywords || []).forEach(k => f.push(['성격', k]));
  f.push(['성격', d.personality_text], ['특징', d.features], ['과거', d.past]);
  if (d.quote) f.push(['한마디', d.quote.text], ['CV', d.quote.cv]);
  (d.relations || []).forEach(r => {
    const linked = r.char_id && byId(r.char_id);
    f.push(['관계', linked ? linked.data.name : r.name], ['관계', r.label], ['관계', r.desc]);
  });
  return f.filter(x => trim(x[1]));
}
function matchChar(c, tokens) {
  if (!tokens.length) return { ok: true };
  const fields = searchFields(c.data);
  let hit = null;
  for (const t of tokens) {
    const found = fields.find(([, v]) => String(v).toLowerCase().includes(t));
    if (!found) return { ok: false };
    if (!hit && found[0] !== '이름') hit = { label: found[0], text: String(found[1]), token: t };
  }
  return { ok: true, hit };
}
function snippet(text, token) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(token);
  if (i < 0) return esc(flat.slice(0, 40));
  const s = Math.max(0, i - 14), e = Math.min(flat.length, i + token.length + 24);
  return (s > 0 ? '…' : '') + esc(flat.slice(s, i)) + '<mark>' + esc(flat.slice(i, i + token.length)) + '</mark>' + esc(flat.slice(i + token.length, e)) + (e < flat.length ? '…' : '');
}

function renderList(main) {
  main.innerHTML = `
    <section class="finder">
      <label class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="이름이나 키워드로 찾기 (예: 피아노, 17, 소꿉친구)" aria-label="캐릭터 검색" value="${esc(listQ)}">
      </label>
      <p class="result-note" id="note" aria-live="polite"></p>
    </section>
    <div class="grid" id="grid"></div>`;
  const q = $('#q');
  q.addEventListener('input', () => { listQ = q.value; drawGrid(); });
  drawGrid();
}

function drawGrid() {
  const grid = $('#grid'), note = $('#note');
  if (!grid) return;
  const tokens = listQ.toLowerCase().split(/\s+/).filter(Boolean);
  const filtering = tokens.length > 0;
  if (!chars.length) {
    grid.outerHTML = `<div class="empty" id="grid"><strong>아직 등록된 캐릭터가 없어요</strong>${editMode ? '<a class="btn solid" href="#/new">첫 캐릭터 등록하기</a>' : '<span>캐릭터가 등록되면 여기에 도감처럼 모여요.</span>'}</div>`;
    note.textContent = '';
    return;
  }
  const rows = [];
  chars.forEach((c, i) => {
    const m = matchChar(c, tokens);
    if (m.ok) rows.push({ c, i, hit: m.hit });
  });
  note.textContent = filtering ? (rows.length ? `${rows.length}명을 찾았어요.` : '') : `${chars.length}명`;
  if (!rows.length) {
    grid.className = 'empty';
    grid.innerHTML = `<strong>찾는 캐릭터가 없어요</strong><span>다른 단어로 찾아보세요. 띄어 쓴 단어가 모두 들어 있는 캐릭터만 보여 줘요.</span>`;
    return;
  }
  grid.className = 'grid';
  grid.innerHTML = rows.map(({ c, i, hit }) => {
    const d = c.data;
    const sub = trim(d.world) || trim(d.job);
    const move = editMode && !filtering ? `<div class="card-move">
        <button type="button" data-move="-1" data-i="${i}" aria-label="${esc(d.name)} 앞으로" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button type="button" data-move="1" data-i="${i}" aria-label="${esc(d.name)} 뒤로" ${i === chars.length - 1 ? 'disabled' : ''}>▶</button>
      </div>` : '';
    return `<div class="card-wrap" style="${pcStyle(d)}">
      <a class="card" href="#/c/${encodeURIComponent(c.id)}">
        <div class="card-art"><img alt="" data-media="${esc(thumbOf(d))}" loading="lazy"></div>
        <div class="card-plate">
          <span class="card-name">${esc(d.name)}</span>
          <span class="card-sub">${sub ? esc(sub) : '&nbsp;'}</span>
          ${hit ? `<span class="card-hit">${esc(hit.label)}: ${snippet(hit.text, hit.token)}</span>` : ''}
        </div>
      </a>${move}</div>`;
  }).join('');
  $$('[data-move]', grid).forEach(b => b.onclick = () => moveChar(+b.dataset.i, +b.dataset.move));
  hydrate(grid);
}

async function moveChar(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= chars.length) return;
  const prev = chars.slice();
  [chars[i], chars[j]] = [chars[j], chars[i]];
  drawGrid();
  const target = $(`[data-i="${j}"][data-move="${dir}"]`) || $(`[data-i="${j}"]`);
  if (target && !target.disabled) target.focus();
  try {
    if (!(await ensurePw())) throw new Error('cancel');
    await api.reorder(pw, chars.map(c => c.id));
  } catch (e) {
    chars = prev; drawGrid();
    if (isAuthErr(e)) forget();
    if (e.message !== 'cancel') toast('순서를 저장하지 못했어요. ' + errText(e));
  }
}

function renderDetail(main, id) {
  const c = byId(id);
  if (!c) {
    main.innerHTML = `<div class="empty"><strong>이 캐릭터를 찾을 수 없어요</strong><span>주소가 바뀌었거나 삭제된 캐릭터예요.</span><a class="btn" href="#/">목록으로 돌아가기</a></div>`;
    return;
  }
  const d = c.data;
  const q = d.quote || {};
  const hasDialog = !!(trim(q.text) || q.voice);
  const stats = [['나이', d.age], ['성별', d.gender], ['키', fmtHeight(d.height)], ['체형', d.body], ['생일', d.birthday], ['직업', d.job], ['종족', d.species]]
    .filter(([, v]) => trim(v));
  const alts = (d.alt_names || []).filter(a => trim(a.value));
  const kws = (d.keywords || []).filter(k => trim(k));
  const rels = (d.relations || []).filter(r => (r.char_id && byId(r.char_id)) || trim(r.name));
  const right = [];
  if (kws.length || trim(d.personality_text)) right.push(`<section class="panel"><h2><span>성격</span></h2>${kws.length ? `<div class="keywords">${kws.map(k => `<span class="kw">${esc(k)}</span>`).join('')}</div>` : ''}${trim(d.personality_text) ? `<p class="prose">${esc(d.personality_text)}</p>` : ''}</section>`);
  if (trim(d.features)) right.push(`<section class="panel"><h2><span>특징</span></h2><p class="prose">${esc(d.features)}</p></section>`);
  if (trim(d.past)) right.push(`<section class="panel"><h2><span>과거</span></h2><p class="prose">${esc(d.past)}</p></section>`);
  const latin = alts.find(a => /^[\x20-\x7e]+$/.test(trim(a.value)));
  const wm = latin ? trim(latin.value) : d.name;
  const statsHTML = stats.length ? `<dl class="stats-mini">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '';
  const sheet = right.length ? `<div class="sheet">${right.join('')}</div>` : '';
  const relHTML = rels.length ? `<section class="panel" style="margin-top:20px"><h2><span>관계</span></h2><div class="relations">${rels.map(r => {
    const linked = r.char_id && byId(r.char_id);
    const name = linked ? linked.data.name : r.name;
    const face = linked ? thumbOf(linked.data) : r.face;
    const inner = `${face ? `<img class="rel-face" alt="" data-media="${esc(face)}">` : `<span class="rel-face none" aria-hidden="true">${esc([...trim(name)][0] || '?')}</span>`}
      <div><div class="rel-name">${esc(name)}</div>${trim(r.label) ? `<div class="rel-label">${esc(r.label)}</div>` : ''}${trim(r.desc) ? `<div class="rel-desc">${esc(r.desc)}</div>` : ''}</div>`;
    return linked ? `<a class="rel" href="#/c/${encodeURIComponent(linked.id)}" style="${pcStyle(linked.data)}">${inner}</a>` : `<div class="rel">${inner}</div>`;
  }).join('')}</div></section>` : '';
  const art = d.full
    ? `<img class="full" alt="${esc(d.name)} 전신 이미지" data-media="${esc(d.full)}">`
    : `<img class="bust" alt="${esc(d.name)} 두상 이미지" data-media="${esc(d.portrait && d.portrait.img)}">`;
  const bubble = cls => `<div class="bubble ${cls}" role="group" aria-label="한마디">
    <p class="bubble-text">${trim(q.text) ? '' : '…'}</p>
    ${q.voice || trim(q.cv) ? `<div class="bubble-foot">
      ${q.voice ? `<button class="play" type="button" aria-label="보이스 재생"><svg class="i-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><svg class="i-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg></button>` : ''}
      ${trim(q.cv) ? `<span class="bubble-cv">CV. ${esc(q.cv)}</span>` : ''}
    </div>` : ''}
  </div>`;
  main.innerHTML = `<article class="detail" style="${pcStyle(d)}">
    <a class="back" href="#/">◀ 목록</a>
    <div class="banner">
      <div class="banner-art">
        <div class="art-deco" aria-hidden="true">
          <span class="wm">${esc(wm)}</span>
          ${trim(d.world) ? `<span class="seal"><b>${esc(d.world)}</b></span>` : ''}
        </div>
        ${hasDialog ? bubble("bubble-art") : ''}
        <div class="art-frame">${art}</div>
      </div>
      <div class="banner-info">
        ${hasDialog ? bubble("bubble-side") : ''}
        ${trim(d.world) || GROUPS.includes(d.group) ? `<div class="banner-tags">${trim(d.world) ? `<span class="tag">${esc(d.world)}</span>` : ''}${GROUPS.includes(d.group) ? `<span class="tag fill">${esc(d.group)}</span>` : ''}</div>` : ''}
        <h1 class="name">${esc(d.name)}</h1>
        ${alts.length ? `<ul class="alt-names">${alts.map(a => `<li>${trim(a.label) ? `<span>${esc(a.label)}</span>` : ''}${esc(a.value)}</li>`).join('')}</ul>` : ''}
        ${statsHTML}
      </div>
    </div>
    ${sheet}
    ${relHTML}
    ${editMode ? `<div class="detail-actions"><a class="btn solid" href="#/edit/${encodeURIComponent(c.id)}">이 캐릭터 수정</a></div>` : ''}
  </article>`;
  hydrate(main);
  if (hasDialog) setupDialog(d);
}

function setupDialog(d) {
  const boxes = $$('.bubble');
  const outs = boxes.map(b => $('.bubble-text', b));
  const text = trim(d.quote.text);
  if (text) outs.forEach(o => { o.textContent = text; });
  const plays = $$('.play');
  const setState = st => plays.forEach(p => {
    p.classList.toggle('playing', st === 'play');
    p.classList.toggle('loading', st === 'load');
    p.setAttribute('aria-label', st === 'play' ? '보이스 멈추기' : '보이스 재생');
  });
  plays.forEach(play => play.addEventListener('click', async e => {
    e.stopPropagation();
    if (audio && !audio.paused) { audio.pause(); audio.currentTime = 0; setState(''); return; }
    setState('load');
    try {
      const src = await mediaSrc(d.quote.voice);
      if (!src) throw new Error('bad_payload');
      audio = new Audio(src);
      audio.onended = () => setState('');
      await audio.play();
      setState('play');
    } catch (ex) { setState(''); toast('보이스를 재생하지 못했어요. ' + errText(ex)); }
  }));
}

function readFile(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('bad_payload')); r.readAsDataURL(file); });
}
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch { throw new Error('bad_payload'); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function encode(canvas, q) {
  let out = canvas.toDataURL('image/webp', q);
  if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', q);
  return out;
}
function square(img, size) {
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(size, s) || size;
  c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, c.width, c.height);
  return encode(c, 0.86);
}
function fit(img, max) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return encode(c, 0.86);
}
const mimeOf = dataUrl => (dataUrl.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';

function renderEdit(main, id) {
  const existing = id ? byId(id) : null;
  if (id && !existing) {
    main.innerHTML = `<div class="empty"><strong>이 캐릭터를 찾을 수 없어요</strong><a class="btn" href="#/">목록으로 돌아가기</a></div>`;
    return;
  }
  const f = JSON.parse(JSON.stringify(existing ? existing.data : {}));
  f.alt_names = f.alt_names || [];
  f.keywords = f.keywords || [];
  f.relations = f.relations || [];
  f.quote = f.quote || { text: '', voice: '', cv: '' };
  f.portrait = f.portrait || {};
  const pending = { portrait: null, full: null, voice: null, faces: new Map() };
  const worlds = [...new Set(chars.map(c => trim(c.data.world)).filter(Boolean))];
  const pcVal = /^#[0-9a-f]{6}$/i.test(f.point_color || '') ? f.point_color : DEFAULT_PC;
  const text = (k, label, opts = {}) => {
    const v = esc(f[k] || '');
    const input = opts.area
      ? `<textarea class="textarea" data-k="${k}" ${opts.ph ? `placeholder="${esc(opts.ph)}"` : ''}>${v}</textarea>`
      : `<input class="input" data-k="${k}" value="${v}" ${opts.list ? `list="${opts.list}"` : ''} ${opts.ph ? `placeholder="${esc(opts.ph)}"` : ''}>`;
    return `<label class="field${opts.wide ? ' wide' : ''}"><span>${label}${opts.req ? '<em>*</em>' : ''}</span>${opts.suffix ? `<div class="suffix">${input}<b>${opts.suffix}</b></div>` : input}${opts.hint ? `<small>${opts.hint}</small>` : ''}</label>`;
  };

  main.innerHTML = `<form class="form" id="form" novalidate>
    <h1>${existing ? esc(f.name) + ' 수정' : '새 캐릭터'}</h1>
    <section class="panel"><h2>이미지</h2>
      <div class="uploads">
        <div><label class="drop" id="drop-portrait"><span>두상 이미지 올리기<br><small>정사각형으로 자동 자르기</small></span><input type="file" accept="image/*" id="in-portrait" aria-label="두상 이미지 (필수)"></label>
          <div class="upload-foot"><span class="status">두상 <b style="color:var(--danger)">*</b></span></div></div>
        <div><label class="drop tall" id="drop-full"><span>전신·반신 이미지 올리기<br><small>선택 사항</small></span><input type="file" accept="image/*" id="in-full" aria-label="전신 또는 반신 이미지 (선택)"></label>
          <div class="upload-foot"><span class="status">전신·반신</span><button class="btn small ghost" type="button" id="rm-full" hidden>빼기</button></div></div>
      </div>
    </section>
    <section class="panel"><h2>이름</h2>
      <div class="fields">${text('name', '이름', { req: true, wide: true })}</div>
      <div class="field wide" style="margin-top:14px"><span>다른 표기</span><div class="list-rows" id="alts"></div>
        <button class="btn small" type="button" id="add-alt" style="width:fit-content;margin-top:4px">표기 추가</button></div>
    </section>
    <section class="panel"><h2>소속과 색</h2>
      <div class="fields">
        ${text('world', '세계관', { list: 'world-list', ph: '고르거나 새로 적기' })}
        <div class="field"><span>커뮤니티 / 자캐연합</span><div class="seg" role="radiogroup" aria-label="커뮤니티 또는 자캐연합">
          ${['', ...GROUPS].map(g => `<label><input type="radio" name="group" value="${g}" ${(f.group || '') === g ? 'checked' : ''}><span>${g || '없음'}</span></label>`).join('')}
        </div></div>
        <div class="field"><span>포인트 컬러</span><div class="color-row"><input type="color" id="pc-pick" value="${pcVal}" aria-label="포인트 컬러 고르기"><input class="input" id="pc-hex" value="${pcVal}" aria-label="포인트 컬러 코드" maxlength="7"></div></div>
      </div>
      <datalist id="world-list">${worlds.map(w => `<option value="${esc(w)}">`).join('')}</datalist>
    </section>
    <section class="panel"><h2>기본 정보</h2>
      <div class="fields">
        ${text('age', '나이')}${text('gender', '성별')}${text('height', '키', { suffix: 'cm' })}${text('body', '체형')}
        ${text('birthday', '생일')}${text('job', '직업')}${text('species', '종족')}
      </div>
    </section>
    <section class="panel"><h2>한마디</h2>
      <div class="fields">
        <label class="field wide"><span>대사</span><textarea class="textarea" id="q-text" style="min-height:80px">${esc(f.quote.text || '')}</textarea></label>
        <div class="field wide"><span>보이스 파일</span><div class="audio-box" id="voice-box"></div><small>2MB까지 올릴 수 있어요. mp3, m4a, ogg 같은 짧은 파일을 추천해요.</small></div>
        <label class="field"><span>CV</span><input class="input" id="q-cv" value="${esc(f.quote.cv || '')}" placeholder="비워 두면 표시하지 않아요"></label>
      </div>
    </section>
    <section class="panel"><h2><span>성격</span></h2>
      <div class="field wide"><span>키워드</span><div class="kw-input" id="kw-box"><input id="kw-in" placeholder="입력하고 Enter" aria-label="성격 키워드 추가"></div></div>
      <div class="fields" style="margin-top:14px">${text('personality_text', '서술', { area: true, wide: true })}</div>
    </section>
    <section class="panel"><h2>특징과 과거</h2>
      <div class="fields">${text('features', '특징', { area: true, wide: true })}${text('past', '과거', { area: true, wide: true })}</div>
    </section>
    <section class="panel"><h2>관계</h2>
      <div class="list-rows" id="rels"></div>
      <button class="btn small" type="button" id="add-rel" style="margin-top:10px">관계 캐릭터 추가</button>
    </section>
    <div class="form-actions">
      ${existing ? '<button class="btn danger" type="button" id="del">삭제</button>' : '<span></span>'}
      <span class="status" id="status" role="status"></span>
      <div class="right"><a class="btn ghost" href="${existing ? '#/c/' + encodeURIComponent(id) : '#/'}">취소</a><button class="btn solid" id="save">저장</button></div>
    </div>
  </form>`;

  const setStatus = (msg, bad) => { const s = $('#status'); s.textContent = msg; s.classList.toggle('error', !!bad); };
  $$('[data-k]', main).forEach(el => el.addEventListener('input', () => { f[el.dataset.k] = el.value; }));
  $$('input[name=group]', main).forEach(el => el.addEventListener('change', () => { f.group = el.value; }));
  $('#q-text').addEventListener('input', e => { f.quote.text = e.target.value; });
  $('#q-cv').addEventListener('input', e => { f.quote.cv = e.target.value; });

  const pick = $('#pc-pick'), hex = $('#pc-hex');
  f.point_color = pcVal;
  pick.addEventListener('input', () => { hex.value = pick.value; f.point_color = pick.value; });
  hex.addEventListener('input', () => {
    let v = trim(hex.value);
    if (v && v[0] !== '#') v = '#' + v;
    if (/^#[0-9a-f]{6}$/i.test(v)) { pick.value = v; f.point_color = v.toLowerCase(); }
  });

  function showImg(drop, src) {
    let img = $('img', drop);
    if (!src) { if (img) img.remove(); return; }
    if (!img) { img = document.createElement('img'); img.alt = ''; drop.prepend(img); }
    img.src = src;
  }
  const dropP = $('#drop-portrait'), dropF = $('#drop-full');
  if (f.portrait.img) mediaSrc(f.portrait.img).then(s => showImg(dropP, s)).catch(() => { });
  if (f.full) { mediaSrc(f.full).then(s => showImg(dropF, s)).catch(() => { }); $('#rm-full').hidden = false; }
  $('#in-portrait').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const img = await loadImage(file);
      pending.portrait = { img: square(img, 360), thumb: square(img, 160) };
      showImg(dropP, pending.portrait.img);
      setStatus('');
    } catch (ex) { setStatus(errText(ex), true); }
    e.target.value = '';
  });
  $('#in-full').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const img = await loadImage(file);
      pending.full = fit(img, 1600);
      showImg(dropF, pending.full);
      $('#rm-full').hidden = false;
      setStatus('');
    } catch (ex) { setStatus(errText(ex), true); }
    e.target.value = '';
  });
  $('#rm-full').onclick = () => { pending.full = null; f.full = ''; showImg(dropF, ''); $('#rm-full').hidden = true; };

  function drawVoice() {
    const box = $('#voice-box');
    const has = pending.voice || f.quote.voice;
    box.innerHTML = has
      ? `<audio controls preload="none" id="voice-audio"></audio><div><button class="btn small ghost" type="button" id="voice-rm">보이스 빼기</button> <label class="btn small" style="position:relative">다른 파일로 바꾸기<input type="file" accept="audio/*" id="voice-in" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label></div>`
      : `<label class="btn small" style="position:relative;width:fit-content">보이스 파일 올리기<input type="file" accept="audio/*" id="voice-in" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>`;
    if (has) {
      const a = $('#voice-audio');
      if (pending.voice) a.src = pending.voice;
      else mediaSrc(f.quote.voice).then(s => { a.src = s; }).catch(() => { });
      $('#voice-rm').onclick = () => { pending.voice = null; f.quote.voice = ''; drawVoice(); };
    }
    $('#voice-in').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > VOICE_LIMIT) { setStatus(`보이스 파일이 ${mb(file.size)}예요. 2MB 이하로 줄여서 올려 주세요.`, true); e.target.value = ''; return; }
      if (!/^audio\//.test(file.type)) { setStatus('오디오 파일만 올릴 수 있어요.', true); e.target.value = ''; return; }
      pending.voice = await readFile(file);
      setStatus('');
      drawVoice();
    });
  }
  drawVoice();

  function drawAlts() {
    const box = $('#alts');
    box.innerHTML = f.alt_names.map((a, i) => `<div class="row">
      <input class="input" data-alt="${i}" data-ak="label" value="${esc(a.label || '')}" placeholder="표기 종류 (예: 원문, 한자)" aria-label="표기 종류">
      <input class="input" data-alt="${i}" data-ak="value" value="${esc(a.value || '')}" placeholder="표기" aria-label="표기">
      <button class="btn small ghost" type="button" data-alt-rm="${i}">빼기</button></div>`).join('');
    $$('[data-ak]', box).forEach(el => el.addEventListener('input', () => { f.alt_names[+el.dataset.alt][el.dataset.ak] = el.value; }));
    $$('[data-alt-rm]', box).forEach(b => b.onclick = () => { f.alt_names.splice(+b.dataset.altRm, 1); drawAlts(); });
  }
  $('#add-alt').onclick = () => { f.alt_names.push({ label: '', value: '' }); drawAlts(); $$('#alts [data-ak="label"]').pop().focus(); };
  drawAlts();

  const kwIn = $('#kw-in');
  function drawKw() {
    $$('.kw', $('#kw-box')).forEach(n => n.remove());
    f.keywords.forEach((k, i) => {
      const s = document.createElement('span');
      s.className = 'kw';
      s.innerHTML = `${esc(k)}<button type="button" aria-label="${esc(k)} 빼기">×</button>`;
      $('button', s).onclick = () => { f.keywords.splice(i, 1); drawKw(); kwIn.focus(); };
      kwIn.before(s);
    });
  }
  const addKw = () => {
    const parts = kwIn.value.split(',').map(trim).filter(Boolean);
    parts.forEach(p => { if (!f.keywords.includes(p)) f.keywords.push(p); });
    kwIn.value = '';
    if (parts.length) drawKw();
  };
  kwIn.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addKw(); }
    else if (e.key === 'Backspace' && !kwIn.value && f.keywords.length) { f.keywords.pop(); drawKw(); }
  });
  kwIn.addEventListener('blur', addKw);
  drawKw();

  function drawRels() {
    const box = $('#rels');
    const others = chars.filter(c => c.id !== id);
    box.innerHTML = f.relations.length ? f.relations.map((r, i) => {
      const linked = r.char_id && byId(r.char_id);
      return `<div class="rel-row" data-ri="${i}">
        <div class="rel-row-head"><button class="btn small ghost" type="button" data-rel-rm="${i}">이 관계 빼기</button></div>
        ${linked ? `<div class="drop" style="cursor:default;border-style:solid"><img alt="" data-media="${esc(thumbOf(linked.data))}"></div>`
          : `<label class="drop" data-face="${i}"><span>두상<br>올리기</span><input type="file" accept="image/*" data-face-in="${i}" aria-label="관계 캐릭터 두상"></label>`}
        <div class="fields">
          <label class="field"><span>캐릭터</span><select class="select" data-rk="char_id" data-ri="${i}">
            <option value="">직접 입력 (다른 사람 캐릭터 등)</option>
            ${others.map(c => `<option value="${esc(c.id)}" ${r.char_id === c.id ? 'selected' : ''}>${esc(c.data.name)}</option>`).join('')}
          </select></label>
          ${linked ? '' : `<label class="field"><span>이름</span><input class="input" data-rk="name" data-ri="${i}" value="${esc(r.name || '')}"></label>`}
          <label class="field"><span>관계</span><input class="input" data-rk="label" data-ri="${i}" value="${esc(r.label || '')}" placeholder="예: 소꿉친구, 라이벌"></label>
          <label class="field wide"><span>간단한 설명</span><textarea class="textarea" style="min-height:70px" data-rk="desc" data-ri="${i}">${esc(r.desc || '')}</textarea></label>
        </div></div>`;
    }).join('') : '<p class="note" style="margin:0">아직 적은 관계가 없어요.</p>';
    $$('[data-rk]', box).forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        f.relations[+el.dataset.ri][el.dataset.rk] = el.value;
        if (el.tagName === 'SELECT') drawRels();
      });
    });
    $$('[data-rel-rm]', box).forEach(b => b.onclick = () => {
      const i = +b.dataset.relRm;
      f.relations.splice(i, 1);
      const shifted = new Map();
      pending.faces.forEach((v, k) => { if (k < i) shifted.set(k, v); else if (k > i) shifted.set(k - 1, v); });
      pending.faces = shifted;
      drawRels();
    });
    $$('[data-face]', box).forEach(drop => {
      const i = +drop.dataset.face;
      const r = f.relations[i];
      if (pending.faces.has(i)) showImg(drop, pending.faces.get(i));
      else if (r.face) mediaSrc(r.face).then(s => showImg(drop, s)).catch(() => { });
    });
    $$('[data-face-in]', box).forEach(inp => inp.addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      const i = +inp.dataset.faceIn;
      try {
        const img = await loadImage(file);
        pending.faces.set(i, square(img, 160));
        showImg(inp.closest('.drop'), pending.faces.get(i));
      } catch (ex) { setStatus(errText(ex), true); }
      e.target.value = '';
    }));
    hydrate(box);
  }
  $('#add-rel').onclick = () => { f.relations.push({ char_id: '', name: '', label: '', desc: '', face: '' }); drawRels(); };
  drawRels();

  const del = $('#del');
  if (del) {
    let armed = false, t;
    del.onclick = async () => {
      if (!armed) {
        armed = true; del.classList.add('armed'); del.textContent = '한 번 더 누르면 삭제돼요';
        t = setTimeout(() => { armed = false; del.classList.remove('armed'); del.textContent = '삭제'; }, 4000);
        return;
      }
      clearTimeout(t);
      del.disabled = true;
      try {
        if (!(await ensurePw())) throw new Error('cancel');
        await api.remove(pw, id);
        await load();
        toast(`${f.name}을(를) 삭제했어요.`);
        location.hash = '#/';
      } catch (e) {
        if (isAuthErr(e)) forget();
        if (e.message !== 'cancel') setStatus(errText(e), true);
        del.disabled = false; armed = false; del.classList.remove('armed'); del.textContent = '삭제';
      }
    };
  }

  $('#form').addEventListener('submit', async e => {
    e.preventDefault();
    addKw();
    if (!trim(f.name)) { setStatus('이름을 적어 주세요.', true); $('[data-k="name"]').focus(); return; }
    if (!f.portrait.img && !pending.portrait) { setStatus('두상 이미지를 올려 주세요.', true); $('#in-portrait').focus(); return; }
    const btn = $('#save');
    btn.disabled = true;
    try {
      if (!(await ensurePw())) throw new Error('cancel');
      const jobs = [];
      if (pending.portrait) {
        jobs.push(async () => { f.portrait.img = await api.upload(pw, mimeOf(pending.portrait.img), pending.portrait.img); pending.portrait.img = null; });
        jobs.push(async () => { f.portrait.thumb = await api.upload(pw, mimeOf(pending.portrait.thumb), pending.portrait.thumb); pending.portrait = null; });
      }
      if (pending.full) jobs.push(async () => { f.full = await api.upload(pw, mimeOf(pending.full), pending.full); pending.full = null; });
      if (pending.voice) jobs.push(async () => { f.quote.voice = await api.upload(pw, mimeOf(pending.voice), pending.voice); pending.voice = null; });
      pending.faces.forEach((src, i) => jobs.push(async () => { f.relations[i].face = await api.upload(pw, mimeOf(src), src); pending.faces.delete(i); }));
      for (let i = 0; i < jobs.length; i++) {
        btn.textContent = `파일 올리는 중 (${i + 1}/${jobs.length})`;
        await jobs[i]();
      }
      btn.textContent = '저장 중…';
      const clean = {
        name: trim(f.name),
        alt_names: f.alt_names.map(a => ({ label: trim(a.label), value: trim(a.value) })).filter(a => a.value),
        portrait: { img: f.portrait.img, thumb: f.portrait.thumb || f.portrait.img },
        full: f.full || '',
        quote: { text: trim(f.quote.text), voice: f.quote.voice || '', cv: trim(f.quote.cv) },
        world: trim(f.world), group: GROUPS.includes(f.group) ? f.group : '', point_color: validHex(f.point_color),
        keywords: f.keywords.map(trim).filter(Boolean),
        relations: f.relations.map(r => r.char_id
          ? { char_id: r.char_id, label: trim(r.label), desc: trim(r.desc) }
          : { char_id: '', name: trim(r.name), face: r.face || '', label: trim(r.label), desc: trim(r.desc) })
          .filter(r => r.char_id || r.name)
      };
      ['age', 'gender', 'height', 'body', 'birthday', 'job', 'species', 'personality_text', 'features', 'past'].forEach(k => { clean[k] = trim(f[k]); });
      const newId = await api.save(pw, id, clean);
      await load();
      toast(id ? '수정한 내용을 저장했어요.' : `${clean.name}을(를) 등록했어요.`);
      location.hash = '#/c/' + encodeURIComponent(newId || id);
    } catch (ex) {
      btn.disabled = false; btn.textContent = '저장';
      if (ex.message === 'cancel') return;
      if (isAuthErr(ex)) { forget(); setStatus('편집 비밀번호가 맞지 않아요. 저장을 다시 누르면 비밀번호를 다시 물어봐요.', true); return; }
      setStatus(errText(ex), true);
    }
  });
}

function renderManage(main) {
  main.innerHTML = `<div class="form">
    <h1>관리</h1>
    <section class="panel"><h2>저장 공간</h2>
      <div id="usage"><p class="note">사용량을 확인하는 중이에요…</p></div>
    </section>
    <section class="panel"><h2>백업</h2>
      <p class="prose">모든 캐릭터와 이미지, 보이스를 파일 하나로 내려받아요. 서버에 문제가 생겨도 이 파일로 새 프로젝트에 그대로 옮길 수 있어요. 가끔 한 번씩 받아 두세요.</p>
      <div class="manage-actions">
        <button class="btn solid" type="button" id="export">백업 파일 내려받기</button>
        <label class="btn" style="position:relative">백업 파일로 복원하기<input type="file" accept="application/json,.json" id="import" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
      </div>
      <p class="note">복원하면 백업에 있는 캐릭터를 다시 넣어요. 같은 캐릭터가 이미 있으면 백업 내용으로 덮어써요.</p>
      <p class="status" id="backup-status" role="status"></p>
    </section>
    <section class="panel"><h2>편집 비밀번호</h2>
      <p class="prose">비밀번호는 Supabase의 SQL Editor에서 바꿀 수 있어요. 방법은 README의 '편집 비밀번호 바꾸기'에 있어요.</p>
    </section>
  </div>`;
  (async () => {
    const box = $('#usage');
    try {
      const u = await api.usage(pw);
      const pct = Math.min(100, (u.database_bytes / DB_LIMIT) * 100);
      box.innerHTML = `<p style="margin:0"><b>${mb(u.database_bytes)}</b> / 500MB 사용 중 (${pct.toFixed(1)}%)</p>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(1)}" aria-label="데이터베이스 사용량"><div style="width:${Math.max(pct, 0.8)}%"></div></div>
        <p class="note">캐릭터 ${u.character_count}명, 이미지·보이스 ${u.media_count}개 (${mb(u.media_bytes)}). 무료 플랜 한도는 데이터베이스 500MB예요. 서버 기본 용량이 조금 포함돼 있어요.</p>`;
    } catch (e) {
      if (isAuthErr(e)) forget();
      box.innerHTML = `<p class="status error">${esc(errText(e))}</p>`;
    }
  })();
  const st = $('#backup-status');
  $('#export').onclick = async () => {
    const btn = $('#export');
    btn.disabled = true;
    try {
      const list = await api.list();
      const index = await api.mediaIndex();
      const media = [];
      for (let i = 0; i < index.length; i += 8) {
        st.textContent = `파일을 모으는 중 (${Math.min(i + 8, index.length)}/${index.length})`;
        media.push(...await api.mediaFull(index.slice(i, i + 8).map(m => m.id)));
      }
      const payload = { app: 'character-archive', version: 1, exported_at: new Date().toISOString(), characters: list, media };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `character-archive-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      st.classList.remove('error');
      st.textContent = `캐릭터 ${list.length}명과 파일 ${media.length}개를 내려받았어요. (${mb(blob.size)})`;
    } catch (e) { st.classList.add('error'); st.textContent = errText(e); }
    btn.disabled = false;
  };
  $('#import').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    st.classList.remove('error');
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'character-archive' || !Array.isArray(data.characters)) throw new Error('이 사이트에서 내려받은 백업 파일이 아니에요.');
      if (!confirm(`캐릭터 ${data.characters.length}명을 복원할까요? 같은 캐릭터는 백업 내용으로 덮어써요.`)) return;
      if (!(await ensurePw())) return;
      const media = data.media || [];
      for (let i = 0; i < media.length; i++) {
        st.textContent = `파일 복원 중 (${i + 1}/${media.length})`;
        await api.restoreMedia(pw, media[i].id, media[i].mime, media[i].data);
      }
      for (let i = 0; i < data.characters.length; i++) {
        const c = data.characters[i];
        st.textContent = `캐릭터 복원 중 (${i + 1}/${data.characters.length})`;
        await api.restoreChar(pw, c.id, c.data, c.sort_order ?? i + 1);
      }
      await load();
      st.textContent = `캐릭터 ${data.characters.length}명을 복원했어요.`;
    } catch (ex) {
      if (isAuthErr(ex)) forget();
      st.classList.add('error');
      st.textContent = ex instanceof SyntaxError ? '백업 파일을 읽지 못했어요. 파일이 손상되지 않았는지 확인해 주세요.' : errText(ex);
    }
  });
}

if (!LIVE) $('#demo-bar').hidden = false;
window.addEventListener('hashchange', render);
render();
})();
