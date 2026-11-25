// 신입사원 인수인계용 가상 업무 데이터 생성기.
// 실행: node scripts/generate-handover-fixture.js
// 회사·거래처·숫자는 모두 지어낸 것입니다. 규칙(아래 "숨겨 둔 인수인계 포인트")을 알고 만든 데이터라,
// 앱이 그 포인트를 실제로 찾아내는지 확인하는 데도 씁니다.
//
// 가상 상황: 가온유통(가상) 영업지원팀의 B2B 주문관리 업무를 2026년 11월에 신입사원에게 넘깁니다.
// 숨겨 둔 인수인계 포인트
//  1. 2025-07 신ERP 전환 첫 달에 1인당 처리량과 기한내처리율이 크게 떨어졌다가 석 달에 걸쳐 회복
//  2. 2026-02~04 담당자 1명 휴직으로 처리건수가 줄고 미처리잔량이 쌓임
//  3. 분기말(3·6·9·12월)과 연말 성수기(11·12월)에 접수가 몰림
//  4. 담당자가 자주 바뀌었거나 최근 이슈가 많은 거래처일수록 이탈위험이 높음
//  5. 정산오류 이슈와 처리가 오래 걸린 이슈일수록 재발이 잦음
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "test-fixtures");

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createRandom(20261125);
const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round1 = (value) => Math.round(value * 10) / 10;

function pick(weights) {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (const [key, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return Object.keys(weights).at(-1);
}

// ---------------------------------------------------------------------------
// 1. 월별 업무현황 (기간형: 2024-11 ~ 2026-10, 24개월)

function monthlyOps() {
  const header = [
    "월", "처리건수(건)", "담당인원(명)", "1인당처리(건)", "접수건수(건)",
    "미처리잔량(건)", "기한내처리율(%)", "평균처리시간(시간)", "클레임(건)", "시스템", "월구분", "인원변동",
  ];
  const rows = [header];
  let backlog = 18;
  for (let index = 0; index < 24; index += 1) {
    const year = 2024 + Math.floor((index + 10) / 12);
    const month = ((index + 10) % 12) + 1;
    const label = `${year}-${String(month).padStart(2, "0")}`;
    const key = year * 100 + month;

    const quarterEnd = [3, 6, 9, 12].includes(month);
    const peak = month === 11 || month === 12;
    const monthType = peak ? "연말성수기" : quarterEnd ? "분기말" : "일반";
    const system = key < 202507 ? "구시스템" : key <= 202509 ? "신ERP 안정화" : "신ERP";
    const leave = key >= 202602 && key <= 202604;
    const support = key >= 202507 && key <= 202508; // 전환 초기 IT 지원 인력 1명 투입
    const staffing = leave ? "휴직 1명" : support ? "전환 지원 1명" : key === 202605 ? "복귀" : "정상";
    const staff = leave ? 2 : support ? 4 : 3;

    // 접수: 완만한 증가 + 분기말·성수기 몰림
    const intake = Math.round(420 * (1 + index * 0.008) * (quarterEnd ? 1.2 : 1) * (peak ? 1.12 : 1)
      * (system === "신ERP 안정화" ? 1.06 : 1) * (1 + normal() * 0.025)); // 전환기에는 사용법 문의가 늘어남

    // 1인 처리 능력: 신ERP 전환 첫 달 급락 → 회복 후 소폭 개선
    let capacityPerPerson = 172 + index * 0.5;
    if (key === 202507) capacityPerPerson *= 0.55;
    else if (key === 202508) capacityPerPerson *= 0.72;
    else if (key === 202509) capacityPerPerson *= 0.9;
    else if (key >= 202510) capacityPerPerson *= 1.04;
    if (leave) capacityPerPerson *= 1.08; // 남은 인원이 야근으로 버팀
    const capacity = staff * capacityPerPerson * (1 + normal() * 0.015);
    const perPerson = round1(Math.min(capacity, backlog + intake) / staff);
    const processed = Math.round(staff * perPerson);

    backlog = Math.max(0, backlog + intake - processed);
    const pressure = backlog / Math.max(1, intake);
    const onTime = round1(clamp(97.5 - pressure * 22 - (system === "신ERP 안정화" ? { 202507: 11, 202508: 6, 202509: 2 }[key] : 0) - (quarterEnd ? 1.2 : 0) + normal() * 0.5, 60, 99.5));
    const hours = round1(clamp(5.5 + pressure * 14 + (system === "신ERP 안정화" ? { 202507: 6, 202508: 3, 202509: 1 }[key] : 0) + normal() * 0.3, 3, 30));
    const claims = Math.max(0, Math.round(4 + pressure * 18 + (system === "신ERP 안정화" ? { 202507: 9, 202508: 5, 202509: 2 }[key] : 0) + normal() * 1.2));

    rows.push([label, processed, staff, perPerson, intake, backlog, onTime, hours, claims, system, monthType, staffing]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2. 거래처 현황 + 4. 이슈 이력 (기록형)

const NAME_HEAD = ["한결", "다온", "새솔", "누리", "하람", "가람", "마루", "온새", "라온", "빛담", "해솔", "도담", "이음", "보람", "슬기", "아름"];
const NAME_TAIL = ["상사", "마트", "유통", "식품", "물산"];

function makeClients() {
  const names = [];
  for (const head of NAME_HEAD) for (const tail of NAME_TAIL) names.push(`${head}${tail}`);
  for (let i = names.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, 80).map((name, index) => {
    const grade = pick({ A: 20, B: 45, C: 35 });
    const industry = pick({ 대형마트: 20, 편의점: 25, 온라인몰: 35, 급식업체: 20 });
    const terms = pick({ "30일": 45, "60일": 35, "90일": 20 });
    const handoffs = Number(pick({ 0: 35, 1: 35, 2: 20, 3: 10 }));
    const volume = Math.round({ A: 4200, B: 1800, C: 700 }[grade] * Math.exp(normal() * 0.35));
    // 담당자가 자주 바뀐 거래처, 결제가 긴 거래처는 이슈가 잘 생김
    const issueRate = 0.9 * (1 + handoffs * 0.55) * (terms === "90일" ? 1.4 : 1) * (grade === "A" ? 1.2 : 1);
    return { code: `가온${String(index + 1).padStart(3, "0")}`, name, grade, industry, terms, handoffs, volume, issueRate };
  });
}

function makeIssues(clients) {
  const issues = [];
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2026, 9, 31);
  const totalWeight = clients.reduce((sum, client) => sum + client.issueRate, 0);
  for (let i = 0; i < 240; i += 1) {
    let roll = random() * totalWeight;
    const client = clients.find((candidate) => (roll -= candidate.issueRate) <= 0) || clients.at(-1);
    const day = new Date(start + Math.floor(random() * ((end - start) / 86400000 + 1)) * 86400000);
    const type = pick({ 납기지연: 35, 정산오류: 22, 품질불량: 18, 단순문의: 25 });
    const channel = pick({ 전화: 40, 메일: 35, 거래처포털: 25 });
    const baseDays = { 납기지연: 3, 정산오류: 5, 품질불량: 4, 단순문의: 1 }[type];
    const days = Math.max(1, Math.round(baseDays * Math.exp(normal() * 0.45) + (client.terms === "90일" && type === "정산오류" ? 2 : 0)));
    let logit = -2.0;
    if (type === "정산오류") logit += 1.8;
    if (type === "단순문의") logit -= 0.8;
    if (days >= 5) logit += 1.1;
    if (client.handoffs >= 2) logit += 0.5;
    const repeat = random() < 1 / (1 + Math.exp(-logit)) ? "예" : "아니오";
    issues.push({ date: day.toISOString().slice(0, 10), client, type, channel, days, repeat });
  }
  issues.sort((a, b) => a.date.localeCompare(b.date));
  return issues;
}

function clientRows(clients, issues) {
  const rows = [["거래처명", "거래처코드", "등급", "업종", "결제조건", "담당자교체(회)", "평균거래액(만원)", "최근이슈(건)", "미수금(만원)", "이탈위험", "특이사항"]];
  for (const client of clients) {
    const recent = issues.filter((issue) => issue.client === client && issue.date >= "2026-05-01").length;
    const overdueShare = { "30일": 0.05, "60일": 0.15, "90일": 0.45 }[client.terms] * (1 + recent * 0.3) * Math.exp(normal() * 0.5);
    const receivable = Math.round(client.volume * overdueShare / 10) * 10;
    let logit = -2.6 + client.handoffs * 0.8 + recent * 1.0 + (client.terms === "90일" ? 0.6 : 0) - (client.grade === "A" ? 0.4 : 0);
    const risk = random() < 1 / (1 + Math.exp(-logit)) ? "높음" : "낮음";
    // 특이사항은 거래처마다 내용이 달라 분석 요인이 아닌 메모로 읽힙니다.
    let note = "";
    if (client.handoffs >= 3) note = `담당자 ${client.handoffs}번 교체(월 ${client.volume}만원 거래), 이전 담당자와 한 단가·납기 약속 확인 필요`;
    else if (client.terms === "90일" && receivable >= 300) note = `미수금 ${receivable}만원, 매월 10일 독촉 일정 공유 필요`;
    else if (client.grade === "A" && risk === "높음") note = `핵심 거래처(월 ${client.volume}만원), 팀장 동행 인사 권장`;
    else if (recent >= 3) note = `최근 이슈 ${recent}건, 원인 정리본 전달`;
    rows.push([client.name, client.code, client.grade, client.industry, client.terms, client.handoffs, client.volume, recent, receivable, risk, note]);
  }
  return rows;
}

function issueRows(issues) {
  const rows = [["이슈번호", "접수일", "거래처명", "유형", "접수채널", "처리일수(일)", "재발"]];
  issues.forEach((issue, index) => {
    rows.push([`이슈${String(index + 1).padStart(3, "0")}`, issue.date, issue.client.name, issue.type, issue.channel, issue.days, issue.repeat]);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// 3. 정기 업무 일정 (읽기용)

function routineRows() {
  return [
    ["업무", "주기", "기준일", "소요시간(시간)", "중요도", "관련시스템", "주의사항"],
    ["월마감 매출 확정", "매월", "매월 3영업일", 6, "상", "신ERP", "정산오류 이슈를 먼저 닫아야 확정 가능"],
    ["거래처 미수금 점검", "매월", "매월 10일", 3, "상", "신ERP", "90일 결제 거래처부터 확인"],
    ["반품 정산", "매주", "매주 금요일", 2, "중", "신ERP", "분기말 주에는 반품이 몰려 2배 소요"],
    ["주간 주문 리포트", "매주", "매주 월요일 오전", 1.5, "중", "신ERP", "팀장 보고용, 10시 전 공유"],
    ["분기 단가 협의 자료", "분기", "분기 마지막 달 15일", 8, "상", "엑셀", "등급 A 거래처는 영업팀과 함께 준비"],
    ["연말 물량 사전 확보", "연 1회", "10월 말", 10, "상", "엑셀", "11·12월 접수가 평소보다 15% 이상 늘어남"],
    ["거래처 포털 계정 정리", "분기", "분기 첫 주", 2, "하", "거래처포털", "담당자 바뀐 거래처 계정 회수"],
    ["클레임 원인 회의", "매월", "매월 마지막 목요일", 1.5, "중", "-", "재발 이슈만 따로 모아 공유"],
    ["세금계산서 발행 확인", "매월", "매월 말일", 2, "상", "신ERP", "말일이 휴일이면 전 영업일까지"],
    ["신규 거래처 등록 검수", "수시", "요청 후 2영업일", 1, "중", "신ERP", "사업자번호·결제조건 이중 확인"],
  ];
}

// ---------------------------------------------------------------------------

const clients = makeClients();
const issues = makeIssues(clients);
const sheets = [
  ["월별업무현황", monthlyOps()],
  ["거래처현황", clientRows(clients, issues)],
  ["이슈이력", issueRows(issues)],
  ["정기업무일정", routineRows()],
];

mkdirSync(OUT, { recursive: true });
const workbook = XLSX.utils.book_new();
for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
XLSX.writeFile(workbook, path.join(OUT, "handover-sample.xlsx"));
console.log(`생성 완료: handover-sample.xlsx (${sheets.map(([name, rows]) => `${name} ${rows.length - 1}행`).join(", ")})`);
