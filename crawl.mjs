// 구글 항공편에서 편도 가격을 모아 prices.json 으로 저장 (GitHub Actions에서 하루 2번 실행)
// 실행: node crawl.mjs   (Node 18+)
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const CN = ["CAN", "SZX", "MFM", "HKG"];
const DAYS = 42;          // 내일부터 6주
const CONCURRENCY = 4;    // 동시에 조회하는 개수 (너무 많으면 구글이 막을 수 있음)
const KEEP = 8;           // 날짜·노선마다 저장할 항공편 수
const LCC = ["익스프레스", "제주항공", "티웨이", "진에어", "에어부산", "에어서울", "이스타", "Trinity"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

// ---- 구글 항공편 검색 주소(tfs) 만들기: 편도·성인1·일반석 ----
const enc = new TextEncoder();
const str = (f, s) => { const b = enc.encode(s); return [(f << 3) | 2, b.length, ...b]; };
const msg = (tag, inner) => [...tag, inner.length, ...inner];
function tfs(from, to, date) {
  const fd = [...str(2, date), ...msg([0x6a], str(2, from)), ...msg([0x72], str(2, to))];
  const info = [...msg([0x1a], fd), 0x42, 1, 1, 0x48, 1, 0x98, 1, 2];
  return Buffer.from(info).toString("base64url");
}
const url = (f, t, d) => `https://www.google.com/travel/flights?tfs=${tfs(f, t, d)}&hl=ko&gl=KR&curr=KRW`;

// ---- 결과 페이지에서 항공편 읽기 (화면 낭독용 설명문 aria-label 사용) ----
const decode = s => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const to24 = (ap, h, m) => `${String((+h % 12) + (ap === "오후" ? 12 : 0)).padStart(2, "0")}:${m}`;
function parse(html) {
  const labels = [...new Set([...html.matchAll(/aria-label="([^"]*대한민국 원[^"]*)"/g)].map(m => decode(m[1])))];
  const out = [];
  for (const l of labels) {
    const p = l.match(/([\d,]+) 대한민국 원/);
    const a = l.match(/원입니다\. (.+?)의 (직항|(\d+)회 경유) 항공편/);
    const t = [...l.matchAll(/(\d{1,2})월 (\d{1,2}) (오전|오후) (\d{1,2}):(\d{2})에/g)];
    if (!p || !a || t.length < 2) continue;
    const airline = a[1];
    const nextDay = t[0][1] !== t[1][1] || t[0][2] !== t[1][2];
    out.push({
      airline,
      lcc: LCC.some(x => airline.includes(x)),
      direct: a[2] === "직항",
      stops: a[3] ? +a[3] : 0,
      dep: to24(t[0][3], t[0][4], t[0][5]),
      arr: to24(t[1][3], t[1][4], t[1][5]) + (nextDay ? " (+1)" : ""),
      duration: (l.match(/총 비행 시간은 (.+?)입니다/) || [, ""])[1],
      price: +p[1].replace(/,/g, ""),
    });
  }
  const seen = new Set();
  return out.sort((x, y) => x.price - y.price)
    .filter(f => { const k = f.airline + f.dep; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, KEEP);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let blocked = 0;

// ---- 유럽 쿠키 동의 화면("계속하기 전에")이 나오면 "모두 거부"를 골라 쿠키를 받아둠 ----
let cookie = "";
let consenting = null;
async function rejectConsent(html) {
  const forms = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map(m => m[1]);
  const reject = forms.find(f => /name="set_eom"\s+value="true"/.test(f) || /value="true"[^>]*name="set_eom"/.test(f));
  if (!reject) return false;
  const body = new URLSearchParams();
  for (const m of reject.matchAll(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"/g)) body.append(m[1], decode(m[2]));
  const r = await fetch("https://consent.google.com/save", {
    method: "POST", body, redirect: "manual",
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko", "Content-Type": "application/x-www-form-urlencoded" },
  });
  const got = r.headers.getSetCookie().map(c => c.split(";")[0]);
  if (!got.some(c => c.startsWith("SOCS="))) return false;
  cookie = got.join("; ");
  console.log("쿠키 동의 화면 → '모두 거부' 처리 완료");
  return true;
}
const isConsent = html => html.includes("consent.google.com") && html.includes("set_eom");

async function fetchFlights(from, to, date) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url(from, to, date), { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko", ...(cookie && { Cookie: cookie }) } });
      const html = await r.text();
      if (isConsent(html)) {
        // 동시에 여러 개가 동의 화면을 만나도 처리는 한 번만
        consenting ||= rejectConsent(html).finally(() => { consenting = null; });
        await consenting;
        continue;
      }
      if (r.status === 429 || /unusual traffic|recaptcha/i.test(html)) { blocked++; await sleep(20000); continue; }
      const list = parse(html);
      if (list.length || attempt === 2) return list;
    } catch (e) { /* 다시 시도 */ }
    await sleep(3000 + attempt * 4000);
  }
  return [];
}

// ---- 실행 ----
async function main() {
  const kst = new Date(Date.now() + 9 * 3600e3);
  const dates = Array.from({ length: DAYS }, (_, i) => new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1 + i)).toISOString().slice(0, 10));
  const jobs = [];
  for (const c of CN) for (const [f, t] of [[c, "ICN"], ["ICN", c]]) for (const d of dates) jobs.push([f, t, d]);

  const routes = {};
  let done = 0, filled = 0;
  const worker = async () => {
    while (jobs.length) {
      const [f, t, d] = jobs.shift();
      const list = await fetchFlights(f, t, d);
      (routes[`${f}-${t}`] ||= {})[d] = list;
      done++; if (list.length) filled++;
      if (done % 20 === 0) console.log(`${done} 완료 (가격 있음 ${filled}, 차단 ${blocked})`);
      await sleep(800 + Math.random() * 1200);
    }
  };
  const total = jobs.length;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`끝: ${total}건 중 가격 있음 ${filled}, 차단 ${blocked}`);

  // 절반도 못 받았으면 실패 처리 → 기존 prices.json 유지 (GitHub가 실패 메일을 보내줌)
  if (filled < total * 0.5) {
    console.error("가격을 충분히 못 받아서 저장하지 않습니다. (구글 차단 또는 페이지 구조 변경 가능성)");
    process.exit(1);
  }
  // 이번에 못 받은 칸은 이전 값으로 채움
  if (existsSync("prices.json")) {
    try {
      const old = JSON.parse(readFileSync("prices.json", "utf8")).routes || {};
      for (const k in routes) for (const d in routes[k]) if (!routes[k][d].length && old[k]?.[d]?.length) routes[k][d] = old[k][d];
    } catch (e) {}
  }
  writeFileSync("prices.json", JSON.stringify({ updated: new Date().toISOString(), source: "google-flights", routes }));
  console.log("prices.json 저장 완료");
}

main();
