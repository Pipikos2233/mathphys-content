#!/usr/bin/env node
/* Конвейер генерации конспекта:
 *   Sonnet 5 (генерация по учебнику) → SymPy (числовые ответы) →
 *   модель OpenAI (рецензия) → при fail один цикл исправления → файлы + запись в index.json
 *
 * Запуск:
 *   node tools/generate.js --section calculus --id derivative --title "Производная" \
 *       --source textbook/fichtenholz-ch4.md [--prereq seq-limits] [--pages "§4.1-4.3"]
 *
 * Ключи: ANTHROPIC_API_KEY и OPENAI_API_KEY в окружении (или в .env рядом).
 * Источник: файл учебника — .md/.txt (или .pdf, будет приложен как документ).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const ROOT = path.join(__dirname, '..');

// --- .env (не коммитится) ---
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// --- аргументы ---
function arg(name, required = true) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) {
      console.error(`Не указан --${name}. Пример:\n  node tools/generate.js --section calculus --id derivative --title "Производная" --source textbook/ch4.md`);
      process.exit(1);
    }
    return null;
  }
  return process.argv[i + 1];
}

const section = arg('section');
const topicId = arg('id');
const title = arg('title');
const sourcePath = arg('source');
const prereqs = (arg('prereq', false) || '').split(',').filter(Boolean);
const pages = arg('pages', false);

for (const [env, name] of [['ANTHROPIC_API_KEY', 'Anthropic'], ['OPENAI_API_KEY', 'OpenAI']]) {
  if (!process.env[env]) {
    console.error(`Нет ключа ${env} (${name}). Задайте в окружении или в ${envPath}`);
    process.exit(1);
  }
}

const GEN_MODEL = 'claude-sonnet-5';
const REVIEW_MODEL = process.env.OPENAI_REVIEW_MODEL || 'gpt-5.6';

const generatorPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'generator.md'), 'utf8');
const reviewerPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'reviewer.md'), 'utf8');
const quizSchema = fs.readFileSync(path.join(ROOT, 'schemas', 'quiz.schema.json'), 'utf8');

// --- источник: текст или PDF ---
const isPdf = sourcePath.toLowerCase().endsWith('.pdf');
const sourceBlock = isPdf
  ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(sourcePath).toString('base64') } }
  : { type: 'text', text: `<textbook>\n${fs.readFileSync(sourcePath, 'utf8')}\n</textbook>` };
const sourceForReviewer = isPdf
  ? '(источник — PDF, сверяй по внутренней согласованности и общематематической корректности)'
  : fs.readFileSync(sourcePath, 'utf8');

const anthropic = new Anthropic();
const openaiClient = new OpenAI();

function extractJson(text) {
  // модель может обернуть JSON в ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}

async function generate(fixInstructions) {
  const userContent = [
    sourceBlock,
    {
      type: 'text',
      text: [
        `Тема: «${title}»${pages ? ` (${pages} источника)` : ''}.`,
        `JSON-схема теста приложения:\n${quizSchema}`,
        fixInstructions
          ? `\nПРЕДЫДУЩАЯ ВЕРСИЯ НЕ ПРОШЛА ПРОВЕРКУ. Исправь и верни полный объект заново:\n${fixInstructions}`
          : '',
      ].join('\n\n'),
    },
  ];

  const stream = anthropic.messages.stream({
    model: GEN_MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    system: generatorPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'max_tokens') throw new Error('Генерация обрезана по max_tokens');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

function sympyCheck(quiz) {
  try {
    const out = execFileSync('python', [path.join(__dirname, 'sympy_check.py')], {
      input: JSON.stringify(quiz), encoding: 'utf8',
    });
    return { failed: false, report: JSON.parse(out) };
  } catch (e) {
    // код 1 = расхождения; stdout всё равно содержит отчёт
    const out = e.stdout ? e.stdout.toString() : '{}';
    return { failed: true, report: JSON.parse(out || '{}') };
  }
}

async function review(draft) {
  const completion = await openaiClient.chat.completions.create({
    model: REVIEW_MODEL,
    messages: [
      { role: 'system', content: reviewerPrompt },
      {
        role: 'user',
        content: `ИСТОЧНИК:\n${sourceForReviewer}\n\nКОНСПЕКТ:\n${draft.lesson_md}\n\nТЕСТ:\n${JSON.stringify(draft.quiz, null, 2)}`,
      },
    ],
    response_format: { type: 'json_object' },
  });
  return JSON.parse(completion.choices[0].message.content);
}

function describeProblems(sympy, verdict) {
  const parts = [];
  if (sympy.failed) {
    parts.push('SymPy-проверка числовых ответов:\n' + JSON.stringify(sympy.report.results, null, 2));
  }
  for (const err of verdict?.errors || []) {
    if (err.severity === 'critical') {
      parts.push(`[${err.where}] ${err.problem} → ${err.fix}`);
    }
  }
  return parts.join('\n\n');
}

(async () => {
  console.log(`Генерация «${title}» (${GEN_MODEL})...`);
  let draft = await generate(null);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const sympy = sympyCheck(draft.quiz);
    console.log(`SymPy: ${sympy.failed ? 'РАСХОЖДЕНИЯ' : 'ok'} (${sympy.report.checked ?? 0} числовых)`);

    console.log(`Рецензия (${REVIEW_MODEL})...`);
    const verdict = await review(draft);
    const criticals = (verdict.errors || []).filter((e) => e.severity === 'critical');
    console.log(`Рецензент: ${verdict.verdict} (critical: ${criticals.length}, minor: ${(verdict.errors || []).length - criticals.length})`);
    for (const err of verdict.errors || []) {
      console.log(`  [${err.severity}] ${err.where}: ${err.problem}`);
    }

    if (!sympy.failed && verdict.verdict === 'pass') break;
    if (attempt === 2) {
      console.error('\nДва прохода не дали чистой версии — нужен человек. Черновик сохранён в _drafts/.');
      const draftDir = path.join(ROOT, '_drafts');
      fs.mkdirSync(draftDir, { recursive: true });
      fs.writeFileSync(path.join(draftDir, `${topicId}.json`), JSON.stringify({ draft, verdict, sympy: sympy.report }, null, 2));
      process.exit(1);
    }
    console.log('Отправляю на исправление...');
    draft = await generate(describeProblems(sympy, verdict));
  }

  // --- запись файлов ---
  const dir = path.join(ROOT, 'sections', section, topicId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lesson.md'), draft.lesson_md);
  fs.writeFileSync(path.join(dir, 'quiz.json'), JSON.stringify(draft.quiz, null, 2) + '\n');

  // --- index.json: добавить или обновить тему ---
  const indexPath = path.join(ROOT, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  let sec = index.sections.find((s) => s.id === section);
  if (!sec) {
    sec = { id: section, title: section, subject: 'math', topics: [] };
    index.sections.push(sec);
  }
  const existing = sec.topics.find((t) => t.id === topicId);
  const rel = (f) => `sections/${section}/${topicId}/${f}`;
  if (existing) {
    existing.version += 1;
    existing.title = draft.title || title;
  } else {
    sec.topics.push({
      id: topicId, title: draft.title || title, version: 1,
      lesson: rel('lesson.md'), quiz: rel('quiz.json'), prerequisites: prereqs,
    });
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  // --- финальный валидатор (схемы + KaTeX) ---
  console.log('\nВалидатор:');
  execFileSync('node', [path.join(__dirname, 'validate.js')], { stdio: 'inherit' });
  console.log(`\nГотово: ${dir}\nПроверьте глазами, затем: git add -A && git commit && git push`);
})().catch((e) => {
  console.error('Ошибка конвейера:', e.message);
  process.exit(1);
});
