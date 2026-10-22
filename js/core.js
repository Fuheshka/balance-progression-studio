// Чистые функции без DOM: парсинг, валидация, формулы. Тестируются в tests/core.test.js через node --test.
(function (root) {
  'use strict';

  // ---------- Схемы данных ----------
  const SCHEMAS = {
    units: {
      required: ['id', 'name', 'hp', 'attack', 'defense', 'cost'],
      numeric: ['hp', 'attack', 'defense', 'cost', 'crit_chance', 'crit_mult', 'attack_speed'],
      positive: ['hp'],
    },
    loot: {
      required: ['id', 'item', 'chance'],
      numeric: ['chance'],
      positive: [],
    },
  };

  // ---------- CSV ----------
  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 1 ? counts[0][0] : ',';
  }

  // RFC 4180: кавычки, экранирование "", переводы строк внутри кавычек.
  function parseCSV(text, delimiter) {
    text = String(text).replace(/^﻿/, '');
    const d = delimiter || detectDelimiter(text);
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"' && field === '') inQuotes = true;
      else if (c === d) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (inQuotes) throw new Error('CSV: незакрытая кавычка');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
    if (!nonEmpty.length) return { headers: [], rows: [] };
    const headers = nonEmpty[0].map((h) => h.trim());
    const data = nonEmpty.slice(1).map((r, idx) => {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = (r[j] ?? '').trim(); });
      obj.__line = idx + 2; // номер строки в файле для сообщений об ошибках
      if (r.length > headers.length) obj.__extra = r.length - headers.length;
      return obj;
    });
    return { headers, rows: data };
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows, headers) {
    headers = headers || collectHeaders(rows);
    const lines = [headers.map(csvEscape).join(',')];
    rows.forEach((r) => lines.push(headers.map((h) => csvEscape(r[h])).join(',')));
    return lines.join('\n') + '\n';
  }

  function collectHeaders(rows) {
    const set = [];
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (!k.startsWith('__') && !set.includes(k)) set.push(k); }));
    return set;
  }

  // ---------- Валидация ----------
  function isNumeric(v) {
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'string' || v.trim() === '') return false;
    return /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(v.trim());
  }
  function toNumber(v) { return typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.')); }

  // Возвращает { ok, errors[], warnings[], rows } — rows уже с числовыми полями.
  function validate(rawRows, type, headers) {
    const schema = SCHEMAS[type];
    if (!schema) throw new Error('Неизвестный тип данных: ' + type);
    const errors = [], warnings = [];
    headers = headers || collectHeaders(rawRows);
    const missing = schema.required.filter((c) => !headers.includes(c));
    if (missing.length) errors.push({ line: 1, msg: 'В файле не хватает колонок: ' + missing.join(', ') });
    if (!rawRows.length) errors.push({ line: 1, msg: 'В файле есть заголовок, но нет ни одной строки' });
    if (missing.length) return { ok: false, errors, warnings, rows: [] };

    const seen = new Map();
    const rows = rawRows.map((r, i) => {
      const line = r.__line || i + 1;
      const out = {};
      Object.keys(r).forEach((k) => { if (!k.startsWith('__')) out[k] = r[k]; });
      if (r.__extra) warnings.push({ line, msg: `значений больше, чем колонок, лишние (${r.__extra}) отброшены` });
      schema.required.forEach((c) => {
        if (out[c] === '' || out[c] === undefined || out[c] === null) errors.push({ line, col: c, msg: 'пусто, а поле обязательное' });
      });
      schema.numeric.forEach((c) => {
        if (!(c in out) || out[c] === '' || out[c] === null) return;
        if (!isNumeric(out[c])) errors.push({ line, col: c, msg: `ждали число, а тут «${out[c]}»` });
        else {
          out[c] = toNumber(out[c]);
          if (out[c] < 0) errors.push({ line, col: c, msg: 'меньше нуля' });
          if (schema.positive.includes(c) && out[c] === 0) errors.push({ line, col: c, msg: 'должно быть больше нуля' });
        }
      });
      const id = String(out.id ?? '').trim();
      if (id !== '') {
        if (seen.has(id)) errors.push({ line, col: 'id', msg: `id ${id} уже был в строке ${seen.get(id)}` });
        else seen.set(id, line);
      }
      if (isNumeric(out.id)) out.id = toNumber(out.id);
      return out;
    });
    return { ok: errors.length === 0, errors, warnings, rows };
  }

  // JSON: массив объектов или { units: [...] } / { loot: [...] } / { rows: [...] }
  function parseJSON(text, type) {
    const data = JSON.parse(String(text).replace(/^﻿/, ''));
    const arr = Array.isArray(data) ? data : data[type] || data.rows || data.data;
    if (!Array.isArray(arr)) throw new Error(`JSON: ожидался массив объектов или поле «${type}»`);
    arr.forEach((r, i) => { if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error(`JSON: элемент ${i} не объект`); });
    return { headers: collectHeaders(arr), rows: arr.map((r, i) => Object.assign({}, r, { __line: i + 1 })) };
  }

  // ---------- Урон / TTK ----------
  // Урон за удар: max(attack − defense, attack × minRatio) × multiplier.
  // minRatio не даёт урону упасть в ноль, если защита выше атаки (иначе бой бесконечный).
  // Ожидаемый урон с критами: base × (1 + critChance × (critMult − 1)).
  function damage(attacker, target, opts) {
    const o = Object.assign({ minRatio: 0.1, multiplier: 1, critChance: null, critMult: null }, opts);
    const atk = attacker.attack, def = target.defense;
    const base = Math.max(atk - def, atk * o.minRatio) * o.multiplier;
    const cc = clamp(o.critChance ?? attacker.crit_chance ?? 0, 0, 1);
    const cm = Math.max(1, o.critMult ?? attacker.crit_mult ?? 1.5);
    return { base, crit: base * cm, expected: base * (1 + cc * (cm - 1)), critChance: cc, critMult: cm };
  }

  // Удары до убийства = ceil(hp / урон). TTK = (удары − 1) / скорость атаки: первый удар в момент t = 0.
  function ttk(attacker, target, opts) {
    const d = damage(attacker, target, opts);
    const aps = Math.max(1e-9, (opts && opts.attackSpeed) ?? attacker.attack_speed ?? 1);
    const hitsNoCrit = d.base > 0 ? Math.ceil(target.hp / d.base - 1e-9) : Infinity;
    const hitsExpected = d.expected > 0 ? Math.ceil(target.hp / d.expected - 1e-9) : Infinity;
    const hitsAllCrit = d.crit > 0 ? Math.ceil(target.hp / d.crit - 1e-9) : Infinity;
    return {
      damage: d,
      attackSpeed: aps,
      hits: { worst: hitsNoCrit, expected: hitsExpected, best: hitsAllCrit },
      ttk: { worst: (hitsNoCrit - 1) / aps, expected: (hitsExpected - 1) / aps, best: (hitsAllCrit - 1) / aps },
    };
  }

  // ---------- Прогрессия ----------
  // XP до следующего уровня: round(base × L^power + linear × (L − 1)), L = текущий уровень.
  function progression(p) {
    const o = Object.assign({ base: 100, power: 1.5, linear: 0, maxLevel: 20 }, p);
    const levels = [];
    let total = 0;
    for (let L = 1; L <= o.maxLevel; L++) {
      const toNext = L === o.maxLevel ? 0 : Math.round(o.base * Math.pow(L, o.power) + o.linear * (L - 1));
      levels.push({ level: L, xpToNext: toNext, totalXp: total });
      total += toNext;
    }
    return levels;
  }

  // ---------- Лут ----------
  // Сумма chance в каждой группе (колонка group, иначе одна группа) должна быть ровно 100%.
  function checkLoot(rows, tolerance) {
    const tol = tolerance ?? 1e-6;
    const groups = new Map();
    const rowIssues = rows.map((r) => {
      const issues = [];
      const c = r.chance;
      if (typeof c !== 'number' || !Number.isFinite(c)) issues.push('chance не число');
      else {
        if (c < 0) issues.push('отрицательная вероятность');
        if (c > 100) issues.push('больше 100%');
        if (c === 0) issues.push('нулевая вероятность (предмет не выпадет)');
      }
      const g = r.group === undefined || r.group === '' ? '—' : String(r.group);
      if (!groups.has(g)) groups.set(g, { group: g, sum: 0, count: 0 });
      const gr = groups.get(g);
      gr.count++;
      if (typeof c === 'number' && Number.isFinite(c)) gr.sum += c;
      return issues;
    });
    const groupList = [...groups.values()].map((g) => {
      const sum = Math.round(g.sum * 1e9) / 1e9; // гасим погрешность float: 0.1+0.2
      return Object.assign(g, { sum, ok: Math.abs(sum - 100) <= tol, diff: Math.round((sum - 100) * 1e9) / 1e9 });
    });
    const ok = groupList.every((g) => g.ok) && rowIssues.every((i) => i.length === 0 || (i.length === 1 && i[0].startsWith('нулевая')));
    return { ok, groups: groupList, rowIssues };
  }

  function normalizeLoot(rows) {
    const sums = new Map();
    rows.forEach((r) => { const g = r.group ?? ''; sums.set(g, (sums.get(g) || 0) + Math.max(0, r.chance || 0)); });
    return rows.map((r) => {
      const s = sums.get(r.group ?? '');
      return Object.assign({}, r, { chance: s > 0 ? Math.round((Math.max(0, r.chance || 0) / s) * 100 * 1e6) / 1e6 : 0 });
    });
  }

  // ---------- Аудит баланса ----------
  // Дуэль «каждый с каждым»: побеждает тот, у кого ожидаемый TTK меньше (при равенстве — ничья).
  // Эффективность = доля побед / (стоимость / медианная стоимость). Доминирующий: эффективность ≥ 1.3 × медианы,
  // бесполезный: ≤ 0.7 × медианы. Дополнительно сила = hp × урон в секунду по средней цели / cost (закон Ланчестера).
  function audit(units, opts) {
    const n = units.length;
    if (n < 2) return [];
    const res = units.map((u) => ({ id: u.id, name: u.name, wins: 0, draws: 0, losses: 0 }));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = ttk(units[i], units[j], opts).ttk.expected;
      const b = ttk(units[j], units[i], opts).ttk.expected;
      if (a < b) res[i].wins++; else if (a > b) res[i].losses++; else res[i].draws++;
    }
    const medianCost = median(units.map((u) => u.cost || 0)) || 1;
    res.forEach((r, i) => {
      const u = units[i];
      r.winRate = (r.wins + r.draws * 0.5) / (n - 1);
      const avgDps = units.reduce((s, t, j) => (j === i ? s : s + damage(u, t, opts).expected * (u.attack_speed ?? 1)), 0) / (n - 1);
      r.powerPerCost = u.cost > 0 ? (u.hp * avgDps) / u.cost : Infinity;
      r.efficiency = u.cost > 0 ? r.winRate / (u.cost / medianCost) : Infinity;
    });
    const medEff = median(res.map((r) => r.efficiency).filter(Number.isFinite)) || 1;
    res.forEach((r) => {
      r.relative = r.efficiency / medEff;
      r.verdict = r.relative >= 1.3 ? 'dominant' : r.relative <= 0.7 ? 'useless' : 'ok';
    });
    return res;
  }

  // ---------- Инфляция ----------
  // Источники и стоки: amount за шаг, growth — % роста amount за шаг. Баланс_t = баланс_{t−1} + Σисточники − Σстоки.
  function simulateEconomy(start, sources, sinks, steps) {
    const out = [{ step: 0, balance: start, income: 0, spend: 0 }];
    let bal = start;
    for (let t = 1; t <= steps; t++) {
      const k = (x) => x.amount * Math.pow(1 + (x.growth || 0) / 100, t - 1);
      const income = sources.reduce((s, x) => s + k(x), 0);
      const spend = sinks.reduce((s, x) => s + k(x), 0);
      bal += income - spend;
      out.push({ step: t, balance: round2(bal), income: round2(income), spend: round2(spend) });
    }
    return out;
  }

  // ---------- Дерево навыков ----------
  // { nodes: [{ id, name, cost?, requires: [id] }] } → глубина по самому длинному пути предков, проверка ссылок и циклов.
  function layoutSkillTree(data) {
    const nodes = Array.isArray(data) ? data : data && data.nodes;
    if (!Array.isArray(nodes)) throw new Error('Ожидается { "nodes": [...] }');
    const byId = new Map();
    const errors = [];
    nodes.forEach((n) => {
      if (n.id === undefined) errors.push('Узел без id: ' + JSON.stringify(n));
      else if (byId.has(String(n.id))) errors.push('Дубль id: ' + n.id);
      else byId.set(String(n.id), n);
    });
    nodes.forEach((n) => (n.requires || []).forEach((r) => { if (!byId.has(String(r))) errors.push(`«${n.id}» ссылается на несуществующий «${r}»`); }));
    const depth = new Map(), state = new Map();
    function visit(id, stack) {
      if (state.get(id) === 2) return depth.get(id);
      if (state.get(id) === 1) { errors.push('Цикл: ' + stack.concat(id).join(' → ')); return 0; }
      state.set(id, 1);
      const reqs = (byId.get(id).requires || []).map(String).filter((r) => byId.has(r));
      const d = reqs.length ? Math.max(...reqs.map((r) => visit(r, stack.concat(id)))) + 1 : 0;
      state.set(id, 2); depth.set(id, d);
      return d;
    }
    byId.forEach((_, id) => visit(id, []));
    const layers = [];
    byId.forEach((n, id) => { const d = depth.get(id) || 0; (layers[d] = layers[d] || []).push(n); });
    return { layers, depth, errors, byId };
  }

  // ---------- Утилиты ----------
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const api = { SCHEMAS, detectDelimiter, parseCSV, toCSV, collectHeaders, isNumeric, toNumber, validate, parseJSON,
    damage, ttk, progression, checkLoot, normalizeLoot, audit, simulateEconomy, layoutSkillTree, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
