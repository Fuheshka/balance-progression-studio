// Запуск: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../js/core.js');

const data = (f) => fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8');
const units = () => C.validate(C.parseCSV(data('units.csv')).rows, 'units').rows;
const byName = (n) => units().find((u) => u.name === n);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('CSV: кавычки, запятая внутри поля, BOM, ; как разделитель', () => {
  const p = C.parseCSV('﻿id;name\n1;"Берсерк; северный"\n2;"Сказал ""да"""\n');
  assert.deepEqual(p.headers, ['id', 'name']);
  assert.equal(p.rows[0].name, 'Берсерк; северный');
  assert.equal(p.rows[1].name, 'Сказал "да"');
  assert.throws(() => C.parseCSV('id,name\n1,"open'), /незакрытая/);
});

test('Валидация units_broken.csv ловит все 6 ошибок', () => {
  const p = C.parseCSV(data('units_broken.csv'));
  const v = C.validate(p.rows, 'units', p.headers);
  assert.equal(v.ok, false);
  const msgs = v.errors.map((e) => `${e.line}:${e.col}`).sort();
  assert.deepEqual(msgs, ['3:hp', '5:id', '6:defense', '7:name', '8:hp', '9:cost'].sort());
  // строка 10: 12.5 и «Берсерк, северный» — валидны
  assert.equal(v.rows[8].attack, 12.5);
  assert.equal(v.rows[9].name, 'Берсерк, северный');
});

test('Валидация: нет обязательной колонки', () => {
  const v = C.validate(C.parseCSV('id,name,hp\n1,a,10').rows, 'units');
  assert.match(v.errors[0].msg, /attack, defense, cost/);
});

test('Урон пример 1: Мечник → Рыцарь (защита гасит урон)', () => {
  const r = C.ttk(byName('Мечник'), byName('Рыцарь'));
  close(r.damage.base, 5);         // max(25−20, 25×0.1) = 5
  close(r.damage.expected, 5.25);  // 5 × (1 + 0.1 × 0.5)
  assert.equal(r.hits.worst, 36);  // ceil(180 / 5)
  assert.equal(r.hits.expected, 35); // ceil(180 / 5.25 = 34.29)
  close(r.ttk.worst, 35);          // (36 − 1) / 1
});

test('Урон пример 2: Маг → Мечник (криты и скорость 0.7)', () => {
  const r = C.ttk(byName('Маг'), byName('Мечник'));
  close(r.damage.base, 35);          // 45 − 10
  close(r.damage.expected, 40.25);   // 35 × (1 + 0.15 × 1)
  assert.equal(r.hits.worst, 4);     // ceil(120 / 35 = 3.43)
  assert.equal(r.hits.expected, 3);  // ceil(120 / 40.25 = 2.98)
  close(r.ttk.worst, 3 / 0.7);       // 4.2857 c
});

test('Урон пример 3: Крестьянин → Голем (минимальный урон 10%)', () => {
  const r = C.ttk(byName('Крестьянин'), byName('Голем'), { critChance: 0 });
  close(r.damage.base, 0.6);        // max(6 − 25, 6 × 0.1)
  assert.equal(r.hits.worst, 534);  // ceil(320 / 0.6 = 533.3)
});

test('Урон: ровное деление не даёт лишнего удара из-за float', () => {
  const r = C.ttk({ attack: 30, attack_speed: 1 }, { hp: 90, defense: 0 }, { critChance: 0 });
  assert.equal(r.hits.worst, 3);
  close(r.ttk.worst, 2);
});

test('Урон: float в ожидаемом уроне не добавляет лишний удар', () => {
  // 8 × (1 + 0.05 × 0.5) = 8.200000000000001, 123 / это = 14.999999999999998 → наивный ceil дал бы 16
  const r = C.ttk({ attack: 18, crit_chance: 0.05, crit_mult: 1.5 }, { hp: 123, defense: 10 });
  assert.equal(r.hits.expected, 15);
});

test('Прогрессия: base=100, power=1.5', () => {
  const lv = C.progression({ base: 100, power: 1.5, linear: 0, maxLevel: 5 });
  assert.deepEqual(lv.map((l) => l.xpToNext), [100, 283, 520, 800, 0]); // 100×2^1.5=282.8, 100×3^1.5=519.6, 100×4^1.5=800
  assert.deepEqual(lv.map((l) => l.totalXp), [0, 100, 383, 903, 1703]);
});

test('Прогрессия: линейная добавка', () => {
  const lv = C.progression({ base: 50, power: 1, linear: 10, maxLevel: 3 });
  assert.deepEqual(lv.map((l) => l.xpToNext), [50, 110, 0]); // 50×2 + 10×1
});

test('Лут: loot.csv валиден, обе группы = 100%', () => {
  const v = C.validate(C.parseCSV(data('loot.csv')).rows, 'loot');
  const r = C.checkLoot(v.rows);
  assert.equal(r.ok, true);
  assert.deepEqual(r.groups.map((g) => g.sum), [100, 100]);
});

test('Лут: loot_broken.csv — сумма chest 102, boss 90, отрицательная вероятность', () => {
  const v = C.validate(C.parseCSV(data('loot_broken.csv')).rows, 'loot');
  assert.ok(v.errors.some((e) => e.line === 9)); // −5 отсекается валидатором
  const r = C.checkLoot(C.parseCSV(data('loot_broken.csv')).rows.map((x) => ({ ...x, chance: Number(x.chance) })));
  assert.equal(r.ok, false);
  assert.deepEqual(r.groups.map((g) => [g.group, g.sum]), [['chest', 102], ['boss', 90]]);
  assert.ok(r.rowIssues[7].includes('отрицательная вероятность'));
});

test('Лут: погрешность float 0.1 + 64.1 + 35.8 = 100', () => {
  assert.notEqual(0.1 + 64.1 + 35.8, 100); // наивная сумма в JS = 99.99999999999999
  assert.equal(C.checkLoot([{ chance: 0.1 }, { chance: 64.1 }, { chance: 35.8 }]).ok, true);
});

test('Лут: нормализация приводит сумму к 100', () => {
  const n = C.normalizeLoot([{ chance: 1 }, { chance: 1 }, { chance: 2 }]);
  assert.deepEqual(n.map((x) => x.chance), [25, 25, 50]);
});

test('Экспорт CSV → импорт: данные без потерь', () => {
  const src = units();
  src[0].name = 'Мечник, "Старый"';
  const back = C.validate(C.parseCSV(C.toCSV(src)).rows, 'units').rows;
  assert.deepEqual(back, src);
  const json = C.validate(C.parseJSON(JSON.stringify({ units: src }), 'units').rows, 'units').rows;
  assert.deepEqual(json, src);
});

test('Аудит: Крестьянин бесполезен, вердикты есть у всех', () => {
  const a = C.audit(units());
  assert.equal(a.length, 12);
  assert.equal(a.find((x) => x.name === 'Крестьянин').verdict, 'useless');
  assert.ok(a.some((x) => x.verdict === 'dominant'));
});

test('Экономика: 100 + 3×(10 − 4) = 118, рост 10%', () => {
  const s = C.simulateEconomy(100, [{ amount: 10 }], [{ amount: 4 }], 3);
  assert.equal(s[3].balance, 118);
  const g = C.simulateEconomy(0, [{ amount: 100, growth: 10 }], [], 2);
  assert.equal(g[2].income, 110);
});

test('Дерево навыков: слои, цикл, битая ссылка', () => {
  const t = C.layoutSkillTree(JSON.parse(data('skills.json')));
  assert.equal(t.errors.length, 0);
  assert.equal(t.depth.get('ultimate'), 4); // str1→str2→cleave→berserk→ultimate
  const bad = C.layoutSkillTree({ nodes: [{ id: 'a', requires: ['b'] }, { id: 'b', requires: ['a'] }, { id: 'c', requires: ['x'] }] });
  assert.ok(bad.errors.some((e) => e.startsWith('Цикл')));
  assert.ok(bad.errors.some((e) => e.includes('несуществующий «x»')));
});
