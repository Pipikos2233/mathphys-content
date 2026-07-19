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
const REVIEW_MODEL = process.env.OPENAI_REVIEW_MODEL || 'gpt-5.6-sol';

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

  // Шлюз подмешивает системный промпт с инструментами (Bash и т.п.), и модель
  // может пытаться их вызывать (stop_reason: tool_use) или возвращать не тот
  // объект (например, только quiz без lesson_md). Оба случая лечим доп. раундом.
  const history = [{ role: 'user', content: userContent }];
  const FORMAT_REMINDER = 'Верни ОДНИМ текстовым сообщением СТРОГО один JSON-объект вида {"title": "...", "lesson_md": "<полный конспект строкой>", "quiz": {...}} — все три поля обязательны. Не вызывай инструменты и не пиши файлы.';
  for (let round = 1; round <= 5; round++) {
    const stream = anthropic.messages.stream({
      model: GEN_MODEL,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: generatorPrompt,
      messages: history,
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'max_tokens') throw new Error('Генерация обрезана по max_tokens');

    if (msg.stop_reason === 'tool_use') {
      history.push({ role: 'assistant', content: msg.content });
      history.push({
        role: 'user',
        content: msg.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({
            type: 'tool_result',
            tool_use_id: b.id,
            is_error: true,
            content: `Инструменты в этом окружении недоступны. ${FORMAT_REMINDER}`,
          })),
      });
      continue;
    }

    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed = null;
    try {
      parsed = extractJson(text);
    } catch (e) { /* переспросим ниже */ }
    if (parsed && typeof parsed.lesson_md === 'string' && parsed.quiz && Array.isArray(parsed.quiz.questions)) {
      return parsed;
    }

    const dumpDir = path.join(ROOT, '_drafts');
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(
      path.join(dumpDir, `${topicId}.raw.json`),
      JSON.stringify({ round, stop_reason: msg.stop_reason, content: msg.content }, null, 2),
    );
    console.log(`  Ответ раунда ${round} не в формате {title, lesson_md, quiz} — переспрашиваю...`);
    history.push({ role: 'assistant', content: msg.content });
    history.push({ role: 'user', content: `Это не тот формат (нужен полный объект, а не его часть). ${FORMAT_REMINDER}` });
  }
  throw new Error(`Модель не вернула корректный объект за 5 раундов; сырой ответ: ${path.join(ROOT, '_drafts', `${topicId}.raw.json`)}`);
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
  // Шлюз не поддерживает /v1/chat/completions (отдаёт пустой ответ) и требует
  // от /v1/responses: stream: true, input списком, без max_output_tokens.
  // response_format тоже не передаём — JSON просим промптом и вырезаем extractJson.
  const stream = await openaiClient.responses.create({
    model: REVIEW_MODEL,
    stream: true,
    input: [
      { role: 'system', content: reviewerPrompt },
      {
        role: 'user',
        content: `ИСТОЧНИК:\n${sourceForReviewer}\n\nКОНСПЕКТ:\n${draft.lesson_md}\n\nТЕСТ:\n${JSON.stringify(draft.quiz, null, 2)}\n\nОтветь ТОЛЬКО JSON-объектом вердикта, без пояснений вне JSON.`,
      },
    ],
  });
  let text = '';
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') text += event.delta;
    else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(`Рецензент (${REVIEW_MODEL}): ${JSON.stringify(event.response?.error || event)}`);
    } else if (event.type === 'response.incomplete') {
      throw new Error(`Рецензент (${REVIEW_MODEL}): ответ оборван (${event.response?.incomplete_details?.reason || 'unknown'})`);
    }
  }
  if (!text.trim()) throw new Error(`Рецензент (${REVIEW_MODEL}): пустой ответ от шлюза`);
  return extractJson(text);
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
