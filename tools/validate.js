#!/usr/bin/env node
// Валидатор контента: схемы + существование файлов + компиляция всех формул KaTeX.
// Запуск: npm run validate. Ненулевой код выхода = контент сломан.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Ajv = require('ajv');
const katex = require('katex');

const ROOT = path.join(__dirname, '..');
const ajv = new Ajv({ allErrors: true });
const errors = [];

function load(p) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
}

// Вырезает формулы из Markdown/текста: сначала $$...$$, потом $...$
function extractFormulas(text) {
  const out = [];
  let rest = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => {
    out.push({ tex: f, display: true });
    return ' ';
  });
  rest.replace(/\$([^$\n]+?)\$/g, (_, f) => {
    out.push({ tex: f, display: false });
    return ' ';
  });
  return out;
}

function checkFormulas(text, where) {
  for (const { tex, display } of extractFormulas(text)) {
    try {
      katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'error' });
    } catch (e) {
      errors.push(`${where}: формула не компилируется KaTeX:\n    $${tex.trim().slice(0, 80)}$\n    ${e.message.split('\n')[0]}`);
    }
  }
}

// 1. Манифест
const indexSchema = load('schemas/index.schema.json');
const quizSchema = load('schemas/quiz.schema.json');
const index = load('index.json');
if (!ajv.validate(indexSchema, index)) {
  errors.push(`index.json: ${ajv.errorsText(ajv.errors)}`);
}

// 2. Темы: файлы существуют, id уникальны, prerequisites указывают на существующие темы
const allTopicIds = new Set();
const allPrereqs = [];

function checkQuizFile(relPath) {
  const quiz = load(relPath);
  if (!ajv.validate(quizSchema, quiz)) {
    errors.push(`${relPath}: ${ajv.errorsText(ajv.errors)}`);
    return;
  }
  for (const q of quiz.questions) {
    const where = `${relPath} #${q.id}`;
    checkFormulas(q.text, where);
    (q.options || []).forEach((o) => checkFormulas(o, where));
    checkFormulas(q.explanation, where);
    if ((q.type === 'choice' || q.type === 'multi') && q.options) {
      const idxs = q.type === 'choice' ? [q.correct] : q.correct;
      for (const i of idxs) {
        if (i >= q.options.length) errors.push(`${where}: correct=${i} выходит за пределы options`);
      }
    }
  }
  // SymPy: пересчёт числовых ответов (python + sympy должны быть установлены)
  try {
    execFileSync('python', [path.join(__dirname, 'sympy_check.py')], {
      input: JSON.stringify(quiz), encoding: 'utf8',
    });
  } catch (e) {
    if (e.stdout) {
      const rep = JSON.parse(e.stdout.toString());
      for (const r of rep.results || []) {
        if (r.status !== 'ok') {
          errors.push(`${relPath} #${r.id}: sympy ${r.status}` +
            (r.computed !== undefined ? ` (получено ${r.computed}, в файле ${r.correct})` : ''));
        }
      }
    } else {
      errors.push(`${relPath}: sympy_check не запустился: ${e.message}`);
    }
  }
}

let examCount = 0;
for (const section of index.sections || []) {
  if (section.exam) {
    if (!fs.existsSync(path.join(ROOT, section.exam))) {
      errors.push(`${section.id}: контрольная не найдена: ${section.exam}`);
    } else {
      checkQuizFile(section.exam);
      examCount++;
    }
  }
  for (const topic of section.topics || []) {
    if (allTopicIds.has(topic.id)) errors.push(`Дубликат id темы: ${topic.id}`);
    allTopicIds.add(topic.id);
    (topic.prerequisites || []).forEach((p) => allPrereqs.push({ from: topic.id, to: p }));

    for (const key of ['lesson', 'quiz']) {
      const p = path.join(ROOT, topic[key]);
      if (!fs.existsSync(p)) {
        errors.push(`${topic.id}: файл не найден: ${topic[key]}`);
        continue;
      }
      if (key === 'lesson') {
        checkFormulas(fs.readFileSync(p, 'utf8'), topic[key]);
      } else {
        checkQuizFile(topic[key]);
      }
    }
  }
}
for (const { from, to } of allPrereqs) {
  if (!allTopicIds.has(to)) errors.push(`${from}: prerequisite "${to}" не существует`);
}

if (errors.length) {
  console.error(`НЕ ПРОШЛО: ${errors.length} ошибок\n`);
  errors.forEach((e) => console.error(' - ' + e + '\n'));
  process.exit(1);
}
console.log(`OK: ${allTopicIds.size} тем, ${examCount} контрольных, все схемы валидны, все формулы компилируются.`);
