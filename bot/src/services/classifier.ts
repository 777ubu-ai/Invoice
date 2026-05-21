import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// Multi-agent classification pipeline.
//
//   Файл xlsx → [Агент 1: Переводчик] → переведённые позиции
//                                    ↓
//                       [Агент 2: Классификатор] → коды ТН ВЭД + ставки
//                                    ↓
//                       [Агент 3: Проверяющий] → проверка, флаги ревью
//
// Каждый этап — отдельный вызов Claude с узким фокусом. Если этап падает —
// pipeline бросает ошибку с указанием на каком этапе, чтобы можно было
// показать понятное сообщение оператору.
// =============================================================================

export interface RawItem {
  index: number;
  article: string;
  text_original: string;
  quantity: number;
  gross_kg: number;
  net_kg: number;
}

export interface TranslatedItem extends RawItem {
  text_translated: string;
}

export interface ClassifiedItem extends TranslatedItem {
  tnved_code: string;
  tnved_description: string;
  duty_rate: number;
  reasoning: string;
  alternatives: { code: string; description: string }[];
}

export interface ReviewedItem extends ClassifiedItem {
  confidence: number;
  needs_review: boolean;
  review_reason?: string;
  reviewer_notes?: string;
}

export function isClaudeEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

function client(): Anthropic {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  return new Anthropic({ apiKey });
}

function extractJson<T>(text: string): T {
  const raw = text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`No JSON object in response: ${raw.slice(0, 300)}`);
  }
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

// -----------------------------------------------------------------------------
// АГЕНТ 1 — ПЕРЕВОДЧИК / ЭКСТРАКТОР
// -----------------------------------------------------------------------------
const TRANSLATOR_PROMPT = `Ты — переводчик packing list с китайского на русский.

ВХОД: текстовое представление xlsx-файла. Структура колонок заранее НЕ известна.

ЗАДАЧИ (только эти, ничего лишнего):
1. Определи где заголовок таблицы (часто R1-R5).
2. Найди колонки: артикул, наименование товара (китайский/английский), количество мест/штук, вес брутто (кг), вес нетто (кг).
3. Извлеки каждую товарную позицию. Пропусти заголовки, итоговые строки (ИТОГО/TOTAL/合计), пустые.
4. Переведи название на русский. Если оригинал на нескольких языках (китайский+английский+русский) — используй существующий русский перевод если он чёткий, иначе сам переведи с китайского.

ВАЖНО — точность данных:
- Если кол-во штук явно НЕ указано — поставь quantity: 0 (НЕ выдумывай).
- Если веса нетто нет, но есть брутто — net_kg = gross_kg * 0.95.
- Если веса брутто нет, но есть нетто — gross_kg = net_kg / 0.95.
- Если артикула нет — сгенерируй короткий код ITEM-N.

НЕ ПЫТАЙСЯ классифицировать по ТН ВЭД на этом этапе. Это сделает другой агент.

ВЫВОД — СТРОГО валидный JSON, без markdown, без преамбулы:
{
  "items": [
    {
      "index": 1,
      "article": "...",
      "text_original": "оригинал из файла",
      "text_translated": "русский перевод",
      "quantity": 100,
      "gross_kg": 200,
      "net_kg": 190
    }
  ]
}`;

export async function agentTranslator(fileText: string): Promise<TranslatedItem[]> {
  const t0 = Date.now();
  const c = client();
  const response = await c.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 12000,
    system: [
      { type: 'text', text: TRANSLATOR_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `Извлеки и переведи позиции из этого packing list:\n\n${fileText}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Агент 1 (Переводчик): пустой ответ');
  }
  const parsed = extractJson<{ items: TranslatedItem[] }>(textBlock.text);
  logger.info(
    {
      ms: Date.now() - t0,
      items: parsed.items.length,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    'agent 1 translator done',
  );
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('Агент 1 (Переводчик): не нашёл ни одной товарной позиции в файле');
  }
  return parsed.items.map((it, idx) => ({ ...it, index: idx + 1 }));
}

// -----------------------------------------------------------------------------
// АГЕНТ 2 — КЛАССИФИКАТОР ТН ВЭД
// -----------------------------------------------------------------------------
const CLASSIFIER_PROMPT = `Ты — таможенный брокер РК с экспертизой по ТН ВЭД ЕАЭС.

ВХОД: список товарных позиций с переводом (наименование, количество, вес).

ЗАДАЧА: для каждой позиции присвоить 10-значный код ТН ВЭД ЕАЭС, описание группы, ставку таможенной пошлины (%), и обоснование выбора кода.

ПРАВИЛА:
- Используй точные 10-значные коды ТН ВЭД (без сокращений).
- Ставка пошлины — действующая в РК на 2026 г.
- Обоснование на русском, 1-2 предложения: что в товаре главное (материал, назначение) и почему именно эта группа.
- Для каждой позиции дай 2-3 альтернативных кода для возможного ревью оператором.

Опорные группы (не исчерпывающий список):
- 9401 — мебель для сидения (стулья, кресла, диваны), ~15%
- 9403 — мебель прочая (столы, шкафы, кровати), ~15%
- 9404 — матрасы, постельные принадлежности, ~12%
- 6910 — сантехника фарфоровая, ~12%
- 7324 — сантехника стальная, ~10%
- 7307/7412/3917 — фитинги (сталь/медь/пластик), 3-6.5%
- 8481 — краны/клапаны, ~5%
- 6109/6110 — одежда трикотажная, ~12-15%
- 8517 — телефоны, ~0-5%
- 8528 — мониторы/ТВ, ~5-10%
- 6402/6403 — обувь, ~15-20%
- 6907 — плитка керамическая, ~15%

ВЫВОД — СТРОГО валидный JSON:
{
  "items": [
    {
      "index": 1,
      "tnved_code": "9403600009",
      "tnved_description": "Мебель деревянная прочая",
      "duty_rate": 15,
      "reasoning": "Артикул и описание указывают на мебель из дерева. Группа 9403 60 — мебель деревянная прочая. Ставка 15%.",
      "alternatives": [
        {"code": "9403200009", "description": "Мебель металлическая прочая"},
        {"code": "9401710009", "description": "Сиденья с металлическим каркасом"}
      ]
    }
  ]
}

Только items в указанном порядке index. Не меняй порядок входных позиций.`;

export async function agentClassifier(items: TranslatedItem[]): Promise<ClassifiedItem[]> {
  const t0 = Date.now();
  const c = client();

  const inputJson = JSON.stringify(
    items.map((it) => ({
      index: it.index,
      article: it.article,
      text_original: it.text_original,
      text_translated: it.text_translated,
      quantity: it.quantity,
      gross_kg: it.gross_kg,
    })),
  );

  const response = await c.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    system: [
      { type: 'text', text: CLASSIFIER_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `Классифицируй эти позиции по ТН ВЭД ЕАЭС:\n\n${inputJson}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Агент 2 (Классификатор): пустой ответ');
  }
  const parsed = extractJson<{
    items: Array<{
      index: number;
      tnved_code: string;
      tnved_description: string;
      duty_rate: number;
      reasoning: string;
      alternatives: { code: string; description: string }[];
    }>;
  }>(textBlock.text);

  logger.info(
    {
      ms: Date.now() - t0,
      items: parsed.items.length,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    'agent 2 classifier done',
  );

  if (!Array.isArray(parsed.items) || parsed.items.length !== items.length) {
    throw new Error(
      `Агент 2 (Классификатор): количество позиций не совпадает (вход ${items.length}, выход ${
        parsed.items?.length ?? 0
      })`,
    );
  }

  const byIndex = new Map(parsed.items.map((p) => [p.index, p]));
  return items.map((it) => {
    const c2 = byIndex.get(it.index);
    if (!c2) {
      throw new Error(`Агент 2 (Классификатор): пропущена позиция ${it.index}`);
    }
    return {
      ...it,
      tnved_code: c2.tnved_code,
      tnved_description: c2.tnved_description,
      duty_rate: c2.duty_rate,
      reasoning: c2.reasoning,
      alternatives: c2.alternatives ?? [],
    };
  });
}

// -----------------------------------------------------------------------------
// АГЕНТ 3 — ПРОВЕРЯЮЩИЙ
// -----------------------------------------------------------------------------
const REVIEWER_PROMPT = `Ты — старший таможенный брокер, который проверяет работу младшего классификатора.

ВХОД: список позиций с присвоенными кодами ТН ВЭД и обоснованиями.

ЗАДАЧА: оцени каждую позицию и поставь confidence (0-100), needs_review (true/false), reviewer_notes (короткий комментарий если нашёл проблему).

КРИТЕРИИ:
- Если код выглядит правильно для описания: confidence 90-100, needs_review: false.
- Если есть неоднозначность (материал не указан, общее название "товар"/"мебель"/"配件"): confidence 60-80, needs_review: true, reviewer_notes объясни сомнения.
- Если код ЯВНО неправильный (например, мебель отнесли к сантехнике): confidence < 60, needs_review: true, reviewer_notes объясни почему неправильно.
- Если ставка пошлины выглядит неверной для этого кода — отметь в reviewer_notes.

ВЫВОД — СТРОГО валидный JSON:
{
  "items": [
    {
      "index": 1,
      "confidence": 95,
      "needs_review": false
    },
    {
      "index": 2,
      "confidence": 65,
      "needs_review": true,
      "reviewer_notes": "Описание '配件' слишком общее. Может быть фитинг стальной (7307), медный (7412) или пластиковый (3917). Уточни материал у поставщика."
    }
  ]
}

Только items, тот же порядок index. Не меняй структуру.`;

export async function agentReviewer(items: ClassifiedItem[]): Promise<ReviewedItem[]> {
  const t0 = Date.now();
  const c = client();

  const inputJson = JSON.stringify(
    items.map((it) => ({
      index: it.index,
      text_original: it.text_original,
      text_translated: it.text_translated,
      quantity: it.quantity,
      gross_kg: it.gross_kg,
      tnved_code: it.tnved_code,
      tnved_description: it.tnved_description,
      duty_rate: it.duty_rate,
      reasoning: it.reasoning,
    })),
  );

  const response = await c.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    system: [
      { type: 'text', text: REVIEWER_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `Проверь работу классификатора:\n\n${inputJson}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Агент 3 (Проверяющий): пустой ответ');
  }
  const parsed = extractJson<{
    items: Array<{
      index: number;
      confidence: number;
      needs_review: boolean;
      reviewer_notes?: string;
    }>;
  }>(textBlock.text);

  logger.info(
    {
      ms: Date.now() - t0,
      items: parsed.items.length,
      flagged: parsed.items.filter((i) => i.needs_review).length,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    'agent 3 reviewer done',
  );

  const byIndex = new Map(parsed.items.map((p) => [p.index, p]));
  return items.map((it) => {
    const r = byIndex.get(it.index);
    if (!r) {
      // Reviewer didn't return data for this item — assume ok with low confidence.
      return { ...it, confidence: 70, needs_review: true, review_reason: 'Проверяющий не вернул оценку' };
    }
    return {
      ...it,
      confidence: r.confidence,
      needs_review: r.needs_review,
      review_reason: r.needs_review ? r.reviewer_notes ?? 'Требует проверки' : undefined,
      reviewer_notes: r.reviewer_notes,
    };
  });
}

// -----------------------------------------------------------------------------
// ПОЛНЫЙ PIPELINE
// -----------------------------------------------------------------------------

export interface PipelineProgress {
  stage: 1 | 2 | 3;
  label: string;
}

export async function runClassificationPipeline(
  fileText: string,
  onProgress?: (p: PipelineProgress) => void | Promise<void>,
): Promise<ReviewedItem[]> {
  onProgress?.({ stage: 1, label: 'Агент 1: перевод и извлечение позиций...' });
  const translated = await agentTranslator(fileText);

  onProgress?.({ stage: 2, label: `Агент 2: подбор кодов ТН ВЭД (${translated.length} поз.)...` });
  const classified = await agentClassifier(translated);

  onProgress?.({ stage: 3, label: 'Агент 3: проверка работы классификатора...' });
  const reviewed = await agentReviewer(classified);

  return reviewed;
}
