#!/usr/bin/env node
/* Финализация исправленного вручную черновика из _drafts/:
 *   SymPy-проверка → рецензия → запись lesson.md/quiz.json → index.json → validate.js
 * Запуск: node tools/finalize_draft.js --section calculus --id number-variable-function --title "..." --source syllabus/....md
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const OpenAI = require('openai');

const ROOT = path.join(__dirname, '..');

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1 || !process.argv[i + 1]) { console.error(`Не указан --${name}`); process.exit(1); }
  return process.argv[i + 1];
}
const section = arg('section');
const topicId = arg('id');
const title = arg('title');
const sourcePath = arg('source');

const REVIEW_MODEL = process.env.OPENAI_REVIEW_MODEL || 'gpt-5.6-sol';
const reviewerPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'reviewer.md'), 'utf8');
const sourceForReviewer = fs.readFileSync(sourcePath, 'utf8');
const openaiClient = new OpenAI();

const draftFile = path.join(ROOT, '_drafts', `${topicId}.json`);
const { draft } = JSON.parse(fs.readFileSync(draftFile, 'utf8'));

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}

async function review(d) {
  const stream = await openaiClient.responses.create({
    model: REVIEW_MODEL,
    stream: true,
    input: [
      { role: 'system', content: reviewerPrompt },
      { role: 'user', content: `ИСТОЧНИК:\n${sourceForReviewer}\n\nКОНСПЕКТ:\n${d.lesson_md}\n\nТЕСТ:\n${JSON.stringify(d.quiz, null, 2)}\n\nОтветь ТОЛЬКО JSON-объектом вердикта, без пояснений вне JSON.` },
    ],
  });
  let text = '';
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') text += event.delta;
    else if (event.type === 'response.failed' || event.type === 'error') throw new Error(JSON.stringify(event));
  }
  if (!text.trim()) throw new Error('пустой ответ рецензента');
  return extractJson(text);
}

(async () => {
  let sympyFailed = false;
  try {
    const out = execFileSync('python', [path.join(__dirname, 'sympy_check.py')], { input: JSON.stringify(draft.quiz), encoding: 'utf8' });
    console.log('SymPy: ok (' + JSON.parse(out).checked + ' числовых)');
  } catch (e) {
    sympyFailed = true;
    console.log('SymPy: РАСХОЖДЕНИЯ');
    console.log(e.stdout ? e.stdout.toString() : '');
  }

  console.log(`Рецензия (${REVIEW_MODEL})...`);
  const verdict = await review(draft);
  const criticals = (verdict.errors || []).filter((e) => e.severity === 'critical');
  console.log(`Рецензент: ${verdict.verdict} (critical: ${criticals.length}, minor: ${(verdict.errors || []).length - criticals.length})`);
  for (const err of verdict.errors || []) console.log(`  [${err.severity}] ${err.where}: ${err.problem}`);

  if (sympyFailed || verdict.verdict !== 'pass') {
    console.error('\nНе pass — файлы не записаны.');
    process.exit(1);
  }

  const dir = path.join(ROOT, 'sections', section, topicId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lesson.md'), draft.lesson_md);
  fs.writeFileSync(path.join(dir, 'quiz.json'), JSON.stringify(draft.quiz, null, 2) + '\n');

  const indexPath = path.join(ROOT, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let sec = index.sections.find((s) => s.id === section);
  if (!sec) { sec = { id: section, title: section, subject: 'math', topics: [] }; index.sections.push(sec); }
  const existing = sec.topics.find((t) => t.id === topicId);
  const rel = (f) => `sections/${section}/${topicId}/${f}`;
  if (existing) { existing.version += 1; existing.title = draft.title || title; }
  else sec.topics.push({ id: topicId, title: draft.title || title, version: 1, lesson: rel('lesson.md'), quiz: rel('quiz.json'), prerequisites: [] });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  console.log('\nВалидатор:');
  execFileSync('node', [path.join(__dirname, 'validate.js')], { stdio: 'inherit' });
  console.log(`\nГотово: ${dir}`);
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
