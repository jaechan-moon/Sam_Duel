// 삼국지 일기토 - 서버 코드 (Cloudflare Worker)
//  POST /api/submit  : 기록 등록 (범위 검사, 닉네임 필터, 점수는 서버가 다시 계산)
//  GET  /api/ranking : 순위 조회 (1~10위만 장비·전법 공개)
//  GET  /api/health  : 연결 확인
// 비밀 열쇠(SUPABASE_SECRET_KEY)는 이 파일 밖(Cloudflare 금고)에만 있습니다.

const VERSION_MAX = 24;
const STAGE_PTS = { '32강 탈락': 0, '16강 탈락': 1, '8강 탈락': 3, '4강 탈락': 6, '준우승': 10, '우승': 15 };
const STAGE_WINS = { '32강 탈락': 0, '16강 탈락': 1, '8강 탈락': 2, '4강 탈락': 3, '준우승': 4, '우승': 5 };
const GOLD_WIN = [50, 100, 100, 150, 300];     // 게임 설정과 같아야 함
const START_GOLD = 100;
const GOLD_ROUNDS = [1, 2];                    // 골드를 받는 대회 회차
const BASE_ROUNDS = 3;
const EXTRA_MAX = 10;
const GOLD_PER_POINT = 200;
const MAX_PER_NICK_PER_DAY = 5;
const TOP_OPEN = 10;                           // 이 순위까지만 장비·전법 공개

// ---------- 닉네임 필터 ----------
// 정규화(공백·기호 제거, 소문자, 비슷한 글자 통일) 후 금지어가 들어 있으면 거절. 운영하면서 계속 늘립니다.
const BAD_WORDS = [
  '시발', '씨발', '씨팔', '시팔', '쉬발', '씹', '병신', '븅신', '개새', '새끼', '쌔끼', '좆', '좇', '존나', '졸라', '지랄', '염병', '닥쳐', '꺼져',
  '니미', '니엄마', '느금', '느그', '애미', '애비', '엠창', '엄창', '창녀', '창년', '걸레', '화냥', '보지', '자지', '섹스', '섹쓰', '야동', '강간', '자위', '성기', '페니스',
  '한남', '김치녀', '메갈', '일베', '노무', '재명', '대깨', '틀딱', '장애', '맘충', '짱깨', '쪽바리', '쪽발', '깜둥', '흑형',
  '히틀러', '나치', '테러', '자살', '죽어', '뒤져', '디져', '뒈져',
  'fuck', 'fuk', 'shit', 'bitch', 'sex', 'dick', 'cock', 'pussy', 'porn', 'nigg', 'fag', 'cunt', 'rape', 'nazi', 'asshole', 'whore', 'slut', 'admin',
];
const NICK_RE = /^[가-힣一-鿿A-Za-z0-9]{1,4}$/;
const LOOK = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

function normalize(s) {
  let t = String(s).normalize('NFKC').toLowerCase();
  t = t.replace(/[\s\-_.,·ㆍ~!?*+/\\|'"`^()[\]{}<>:;]/g, '');
  t = t.replace(/[0134579@$]/g, c => LOOK[c] || c);
  return t;
}
function badNick(nick) {
  const n = normalize(nick);
  return BAD_WORDS.some(w => n.includes(normalize(w)));
}

// ---------- 점수 ----------
function earnedGold(place) {
  let g = 0; const wins = STAGE_WINS[place];
  for (let i = 0; i < wins; i++) g += GOLD_WIN[i];
  return g;
}

function validate(b) {
  if (!b || typeof b !== 'object') return '잘못된 요청입니다.';
  const nick = typeof b.nickname === 'string' ? b.nickname.normalize('NFC').trim() : '';
  if (!NICK_RE.test(nick)) return '이름은 1~4글자의 한글·한자·영문·숫자만 쓸 수 있어요.';
  if (badNick(nick)) return '쓸 수 없는 이름이에요. 다른 이름을 써 주세요.';

  // 대회 기록
  const pl = b.placements;
  if (!Array.isArray(pl) || pl.length < BASE_ROUNDS || pl.length > EXTRA_MAX) return '대회 기록이 올바르지 않습니다.';
  let match = 0, chal = 0, lastRound = 0;
  for (let i = 0; i < pl.length; i++) {
    const p = pl[i];
    if (!p || p.round !== i + 1 || !(p.place in STAGE_PTS)) return '대회 기록이 올바르지 않습니다.';
    if (i + 1 > BASE_ROUNDS) {
      if (i > BASE_ROUNDS && pl[i - 1].place !== '우승') return '대회 기록이 올바르지 않습니다.';   // 5회차부터는 앞 도전 회차를 이겨야 함
      chal += STAGE_PTS[p.place];
    } else match += STAGE_PTS[p.place];
    lastRound = i + 1;
  }
  const challengeRound = lastRound > BASE_ROUNDS ? lastRound : 0;

  // 골드
  const gl = b.gold_left;
  if (!Number.isInteger(gl) || gl < 0) return '골드 기록이 올바르지 않습니다.';
  let maxGold = START_GOLD;
  GOLD_ROUNDS.forEach(r => { maxGold += earnedGold(pl[r - 1].place); });
  if (gl > maxGold) return '골드 기록이 올바르지 않습니다.';
  const goldScore = Math.floor(gl / GOLD_PER_POINT);

  // 능력치
  const st = b.stats;
  if (!Array.isArray(st) || st.length !== 3 || !st.every(v => Number.isInteger(v) && v >= 20 && v <= 100)) return '능력치 기록이 올바르지 않습니다.';
  const sum = st[0] + st[1] + st[2];
  const extraSessions = Math.max(0, lastRound - BASE_ROUNDS);
  const maxSum = 160 + 3 * (15 + 9 * extraSessions);
  if (sum > Math.min(300, maxSum) || sum < 60) return '능력치 기록이 올바르지 않습니다.';

  // 성향·장비 목록
  const idRe = /^[a-z0-9_]{1,24}$/;
  const list = (v, max) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && idRe.test(x)) && new Set(v).size === v.length;
  if (!list(b.ops, 6) || !list(b.items, 2)) return '전법·장비 기록이 올바르지 않습니다.';
  if (!Array.isArray(b.cons) || b.cons.length > 3 || !b.cons.every(x => typeof x === 'string' && idRe.test(x))) return '소모품 기록이 올바르지 않습니다.';
  if (typeof b.trait !== 'string' || !idRe.test(b.trait) || typeof b.ideology !== 'string' || !idRe.test(b.ideology)) return '개성·사상 기록이 올바르지 않습니다.';
  if (b.gender !== 'male' && b.gender !== 'female') return '성별 기록이 올바르지 않습니다.';
  if (typeof b.version !== 'string' || b.version.length < 1 || b.version.length > VERSION_MAX) return '버전 기록이 올바르지 않습니다.';

  return {
    nickname: nick,
    total_score: match + goldScore, match_score: match, gold_score: goldScore, gold_left: gl,
    challenge_score: chal, challenge_round: challengeRound,
    placements: pl.map(p => ({ round: p.round, place: p.place })),
    stats: st, trait: b.trait, ideology: b.ideology, gender: b.gender,
    ops: b.ops, items: b.items, cons: b.cons, version: b.version,
  };
}

// ---------- Supabase ----------
function sb(env, path, init = {}) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function submit(request, env) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 4096) return json({ ok: false, error: '요청이 너무 큽니다.' }, 413);
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json({ ok: false, error: '잘못된 요청입니다.' }, 400); }
  const row = validate(body);
  if (typeof row === 'string') return json({ ok: false, error: row }, 400);

  // 같은 이름으로 하루에 너무 많이 올리는 것을 막음
  const since = new Date(Date.now() - 86400000).toISOString();
  const cnt = await sb(env, 'scores?select=id&limit=1&nickname=eq.' + encodeURIComponent(row.nickname) + '&created_at=gte.' + encodeURIComponent(since),
    { headers: { Prefer: 'count=exact' } });
  const total = Number((cnt.headers.get('content-range') || '').split('/')[1] || 0);
  if (total >= MAX_PER_NICK_PER_DAY) return json({ ok: false, error: '같은 이름으로는 하루에 ' + MAX_PER_NICK_PER_DAY + '번까지만 등록할 수 있어요.' }, 429);

  const ins = await sb(env, 'scores', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
  if (!ins.ok) return json({ ok: false, error: '저장에 실패했습니다. 잠시 뒤 다시 시도해 주세요.' }, 502);
  const saved = (await ins.json())[0];

  // 내 순위 = 나보다 앞선 기록 수 + 1
  const T = row.total_score, C = row.challenge_score, TS = encodeURIComponent(saved.created_at);
  const or = encodeURIComponent('(total_score.gt.' + T + ',and(total_score.eq.' + T + ',challenge_score.gt.' + C +
    '),and(total_score.eq.' + T + ',challenge_score.eq.' + C + ',created_at.lt.' + saved.created_at + '))');
  const r = await sb(env, 'scores?select=id&limit=1&or=' + or, { headers: { Prefer: 'count=exact' } });
  const ahead = Number((r.headers.get('content-range') || '').split('/')[1] || 0);
  return json({ ok: true, rank: ahead + 1, total_score: T, match_score: row.match_score, gold_score: row.gold_score, challenge_score: C, challenge_round: row.challenge_round });
}

async function ranking(request, env) {
  const u = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get('limit')) || 50));
  const cols = 'nickname,total_score,match_score,gold_score,gold_left,challenge_score,challenge_round,placements,created_at,stats,trait,ideology,gender,ops,items,cons';
  const r = await sb(env, 'scores?select=' + cols + '&order=total_score.desc,challenge_score.desc,created_at.asc&limit=' + limit);
  if (!r.ok) return json({ ok: false, error: '순위를 불러오지 못했습니다.' }, 502);
  const rows = await r.json();
  const out = rows.map((x, i) => {
    const o = { rank: i + 1, nickname: x.nickname, total_score: x.total_score, match_score: x.match_score, gold_score: x.gold_score,
      challenge_score: x.challenge_score, challenge_round: x.challenge_round, placements: x.placements, created_at: x.created_at };
    if (i < TOP_OPEN) Object.assign(o, { gold_left: x.gold_left, stats: x.stats, trait: x.trait, ideology: x.ideology, gender: x.gender, ops: x.ops, items: x.items, cons: x.cons });
    return o;
  });
  return json({ ok: true, rows: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/health') {
      return json({ ok: true, has_url: Boolean(env.SUPABASE_URL), has_key: Boolean(env.SUPABASE_SECRET_KEY) });
    }
    if (p === '/api/submit' || p === '/api/ranking') {
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return json({ ok: false, error: '서버 설정이 아직 끝나지 않았습니다.' }, 500);
      try {
        if (p === '/api/submit') return request.method === 'POST' ? await submit(request, env) : json({ ok: false, error: 'POST만 가능합니다.' }, 405);
        return request.method === 'GET' ? await ranking(request, env) : json({ ok: false, error: 'GET만 가능합니다.' }, 405);
      } catch (e) {
        return json({ ok: false, error: '서버 오류가 났습니다.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
