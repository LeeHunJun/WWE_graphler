// 원인 분석(왜?) 기능 테스트용 합성 데이터 생성기.
// 실행: node scripts/generate-driver-fixtures.js
// 실제 데이터가 아니라 규칙을 알고 만든 가상의 데이터라, 분석 결과가 맞는지 검증하는 데 씁니다.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "test-fixtures");

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

function normal(random) {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function pick(random, weights) {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (const [key, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return Object.keys(weights).at(-1);
}

function toCsv(rows) {
  return `﻿${rows.map((row) => row.map((cell) => {
    const text = String(cell ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n")}\n`;
}

function titanicStyle() {
  const random = createRandom(1912);
  const rows = [["승객번호", "생존", "객실등급", "성별", "나이", "동반가족수", "요금(달러)", "승선항구"]];
  for (let id = 1; id <= 300; id += 1) {
    const pclass = Number(pick(random, { 1: 24, 2: 21, 3: 55 }));
    const sex = random() < 0.64 ? "남" : "여";
    const ageBase = { 1: 38, 2: 30, 3: 25 }[pclass];
    const age = random() < 0.12 ? null : Math.max(1, Math.round(ageBase + normal(random) * 13));
    const family = Number(pick(random, { 0: 60, 1: 20, 2: 10, 3: 5, 4: 3, 5: 2 }));
    const fare = Math.round(({ 1: 85, 2: 22, 3: 12 }[pclass] * (1 + family * 0.25) * (0.7 + random() * 0.6)) * 100) / 100;
    const port = pick(random, { S: 70, C: 20, Q: 10 });
    let logit = -1.1;
    if (sex === "여") logit += 2.5;
    if (pclass === 1) logit += 1.1;
    if (pclass === 3) logit -= 1.0;
    if (age !== null && age < 10) logit += 1.4;
    if (age !== null && age >= 60) logit -= 0.7;
    if (family >= 4) logit -= 1.2;
    const survived = random() < 1 / (1 + Math.exp(-logit)) ? 1 : 0;
    rows.push([id, survived, pclass, sex, age ?? "", family, fare.toFixed(2), port]);
  }
  return rows;
}

function monthlySales() {
  const random = createRandom(2025);
  const rows = [["월", "매출(원)", "방문수(명)", "객단가(원)", "커피매출(원)", "디저트매출(원)", "굿즈매출(원)", "영업일수(일)", "비온날(일)", "주변공사", "프로모션", "원가(원)", "인건비(원)", "임대료(원)", "영업이익(원)"]];
  const season = [0.92, 0.88, 0.98, 1.02, 1.06, 1.04, 1.0, 1.0, 1.03, 1.05, 1.0, 1.08];
  const rainBase = [4, 4, 6, 7, 8, 10, 15, 13, 9, 6, 6, 5];
  for (let index = 0; index < 24; index += 1) {
    const year = 2024 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    const label = `${year}-${String(month).padStart(2, "0")}`;
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] - Math.round(2 + random() * 2);
    const rain = Math.max(0, Math.round(rainBase[month - 1] + normal(random) * 2));
    const construction = year === 2025 && month >= 6 && month <= 8 ? "있음" : "없음";
    const promotion = [3, 10, 15, 22].includes(index) ? "있음" : "없음";
    let visitors = days * 112 * season[month - 1] * (1 - 0.018 * rain) * (1 + index * 0.006);
    if (construction === "있음") visitors *= 0.74;
    if (promotion === "있음") visitors *= 1.09;
    visitors = Math.round(visitors * (1 + normal(random) * 0.02));
    let ticket = 7600 + index * 18 + normal(random) * 70;
    if (promotion === "있음") ticket -= 250;
    ticket = Math.round(ticket);
    const revenue = visitors * ticket;
    const coffeeShare = 0.61 + normal(random) * 0.01 + (construction === "있음" ? -0.02 : 0);
    const dessertShare = 0.29 + normal(random) * 0.01;
    const coffee = Math.round(revenue * coffeeShare);
    const dessert = Math.round(revenue * dessertShare);
    const goods = revenue - coffee - dessert;
    const cost = Math.round(revenue * 0.33);
    const labor = 6200000 + Math.round(normal(random) * 120000);
    const rent = 3000000;
    const profit = revenue - cost - labor - rent;
    rows.push([label, revenue, visitors, ticket, coffee, dessert, goods, days, rain, construction, promotion, cost, labor, rent, profit]);
  }
  return rows;
}

writeFileSync(path.join(OUT, "titanic-style-survival.csv"), toCsv(titanicStyle()));
writeFileSync(path.join(OUT, "monthly-sales-drivers.csv"), toCsv(monthlySales()));
console.log("생성 완료: titanic-style-survival.csv, monthly-sales-drivers.csv");
