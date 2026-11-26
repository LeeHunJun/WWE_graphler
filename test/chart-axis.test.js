import assert from "node:assert/strict";
import test from "node:test";
import { getXAxisLayout } from "../visualization.js";

test("짧은 x축 이름은 가로로 두고, 다 못 보여 줄 만큼 길면 대각선으로 모두 보여 준다", () => {
  const short = getXAxisLayout(["남", "여"], 600);
  assert.equal(short.rotate, false);
  assert.equal(short.ticks.maxRotation, 0);

  const months = Array.from({ length: 24 }, (_, index) => `2024-${String(index + 1).padStart(2, "0")}`);
  const rotated = getXAxisLayout(months, 600);
  assert.equal(rotated.rotate, true);
  assert.equal(rotated.ticks.autoSkip, false, "대각선일 때는 이름을 건너뛰지 않는다");
  assert.equal(rotated.ticks.minRotation, 45);
  assert.ok(rotated.extraHeight > 0, "눕힌 글자만큼 그래프 높이를 늘린다");

  const teams = ["영업본부 수도권 1팀", "영업본부 수도권 2팀", "마케팅 전략실", "고객경험 혁신팀", "데이터 분석 센터", "물류 운영 본부"];
  assert.equal(getXAxisLayout(teams, 400).rotate, true, "가로로 겹치는 긴 이름은 눕힌다");
  assert.equal(getXAxisLayout(teams.slice(0, 2), 900).rotate, false, "넓은 화면에 다 들어가면 그대로 둔다");
});

test("항목이 너무 많으면(60개 초과) 눕히지 않고 일부만 표시한다", () => {
  const many = getXAxisLayout(Array.from({ length: 300 }, (_, index) => `항목 ${index}`), 600);
  assert.equal(many.rotate, false);
  assert.equal(many.ticks.autoSkip, true);
});
