import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { loadFeedbackStats, isLikelyBad } from './tnved-feedback.repo.js';
import { validateCode, type TnvedEntry } from './tnved-lookup.js';

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
  // Set by post-classifier validator against bot/data/tnved-eaeu.csv.
  // 'invalid' means the 10-digit code does not exist in ЕАЭС-номенклатуре
  // even after a retry — Маке will hard-fail on such items.
  validation_status: 'valid' | 'invalid';
  official_description?: string;
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

⚠️ КРИТИЧНО — ВАЛИДНОСТЬ СУФФИКСОВ ТН ВЭД ЕАЭС:
Первые 6 цифр кода (товарная позиция + субпозиция) совпадают с международным HS.
Последние 4 цифры — национальная детализация ЕАЭС. НЕ выдумывай их случайно.
Если ты НЕ уверен в точном 10-значном суффиксе — используй ТОЛЬКО эти стандартные окончания:
  - **0000** — основная подсубпозиция «прочие/общее»
  - **9000** или **9009** — «прочие из данной субпозиции»
  - **0009** — для текстиля/одежды
  - **9900** или **0090** — «прочие, не поименованные»
Запрещено выдумывать суффиксы типа **1009**, **3009**, **0050**, **1090** и подобные — большинство таких суффиксов в ЕАЭС не существует.
Если на 100% не знаешь точный суффикс — ставь **0000** и в reasoning явно скажи: «суффикс уточнить по справочнику».

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
- 7323 — изделия столовые/кухонные из чёрных металлов (типичные суффиксы: 910000, 930000, 990000)
- 4419 — изделия столовые/кухонные деревянные (типичные: 110000, 120000, 190000, 900000)
- 6911 — посуда фарфоровая (типичные: 100000, 900000)

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

interface ClassifierResponseItem {
  index: number;
  tnved_code: string;
  tnved_description: string;
  duty_rate: number;
  reasoning: string;
  alternatives: { code: string; description: string }[];
}

async function callClassifierLLM(
  items: TranslatedItem[],
  correctionsHint?: string,
): Promise<Map<number, ClassifierResponseItem>> {
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

  const userMessage = correctionsHint
    ? `${correctionsHint}\n\nПереклассифицируй ТОЛЬКО эти позиции, выбирая код строго из приведённого списка:\n\n${inputJson}`
    : `Классифицируй эти позиции по ТН ВЭД ЕАЭС:\n\n${inputJson}`;

  const response = await c.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    system: [
      { type: 'text', text: CLASSIFIER_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Агент 2 (Классификатор): пустой ответ');
  }
  const parsed = extractJson<{ items: ClassifierResponseItem[] }>(textBlock.text);

  logger.info(
    {
      ms_call: response.usage ? undefined : undefined,
      items: parsed.items?.length ?? 0,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      retry: Boolean(correctionsHint),
    },
    'classifier LLM call done',
  );

  if (!Array.isArray(parsed.items)) {
    throw new Error('Агент 2 (Классификатор): отсутствует поле items');
  }
  return new Map(parsed.items.map((p) => [p.index, p]));
}

function buildCorrectionsHint(
  invalid: Array<{ item: TranslatedItem; badCode: string; siblings: TnvedEntry[] }>,
): string {
  const lines = invalid.map(({ item, badCode, siblings }) => {
    const list = siblings.length
      ? siblings.slice(0, 15).map((s) => `  • ${s.code} — ${s.description}`).join('\n')
      : '  (в этой подгруппе нет 10-значных кодов — выбери из соседних 4-значных подгрупп)';
    return `Позиция #${item.index} «${item.text_translated || item.text_original}»: код ${badCode} НЕ СУЩЕСТВУЕТ в ЕАЭС-номенклатуре. Реальные варианты в этой подгруппе:\n${list}`;
  });
  return `КРИТИЧНО: следующие коды, которые ты выбрал, не существуют в реальной ТН ВЭД ЕАЭС. Выбери код СТРОГО из приведённого списка для каждой позиции — никаких других вариантов.\n\n${lines.join('\n\n')}`;
}

export async function agentClassifier(items: TranslatedItem[]): Promise<ClassifiedItem[]> {
  const t0 = Date.now();

  // First pass — let the classifier choose codes freely.
  let codeByIndex = await callClassifierLLM(items);
  if (codeByIndex.size !== items.length) {
    throw new Error(
      `Агент 2 (Классификатор): количество позиций не совпадает (вход ${items.length}, выход ${codeByIndex.size})`,
    );
  }

  // Validate every code against the local ЕАЭС database.
  let invalidItems: Array<{ item: TranslatedItem; badCode: string; siblings: TnvedEntry[] }> = [];
  for (const it of items) {
    const c2 = codeByIndex.get(it.index)!;
    const v = validateCode(c2.tnved_code);
    if (!v.valid) {
      // Prefer 6-digit siblings (same subheading), fall back to 4-digit heading siblings.
      const siblings = (v.siblings_six && v.siblings_six.length ? v.siblings_six : v.siblings_four) ?? [];
      invalidItems.push({ item: it, badCode: c2.tnved_code, siblings });
    }
  }

  // Single retry pass for invalid codes — pass the real catalogue as a constraint.
  if (invalidItems.length > 0) {
    logger.warn(
      { invalid: invalidItems.length, total: items.length, codes: invalidItems.map((x) => x.badCode) },
      'classifier produced invalid codes — retrying with EAEU catalogue hints',
    );
    const hint = buildCorrectionsHint(invalidItems);
    const retried = await callClassifierLLM(
      invalidItems.map((x) => x.item),
      hint,
    );
    for (const [idx, c2] of retried) {
      codeByIndex.set(idx, c2);
    }
    // Re-validate after retry.
    invalidItems = [];
    for (const it of items) {
      const c2 = codeByIndex.get(it.index)!;
      const v = validateCode(c2.tnved_code);
      if (!v.valid) {
        const siblings = (v.siblings_six && v.siblings_six.length ? v.siblings_six : v.siblings_four) ?? [];
        invalidItems.push({ item: it, badCode: c2.tnved_code, siblings });
      }
    }
  }

  logger.info(
    { ms: Date.now() - t0, items: items.length, still_invalid: invalidItems.length },
    'agent 2 classifier done',
  );

  // Build final ClassifiedItems with validation_status.
  return items.map((it) => {
    const c2 = codeByIndex.get(it.index);
    if (!c2) {
      throw new Error(`Агент 2 (Классификатор): пропущена позиция ${it.index}`);
    }
    const v = validateCode(c2.tnved_code);
    return {
      ...it,
      tnved_code: c2.tnved_code,
      tnved_description: c2.tnved_description,
      duty_rate: c2.duty_rate,
      reasoning: c2.reasoning,
      alternatives: c2.alternatives ?? [],
      validation_status: v.valid ? 'valid' : 'invalid',
      official_description: v.official_description,
    };
  });
}

// -----------------------------------------------------------------------------
// АГЕНТ 3 — ПРОВЕРЯЮЩИЙ
// -----------------------------------------------------------------------------
const REVIEWER_PROMPT = `Ты — старший таможенный брокер, который проверяет работу младшего классификатора.

ВХОД: список позиций с присвоенными кодами ТН ВЭД и обоснованиями.

ЗАДАЧА: оцени каждую позицию и поставь confidence (0-100), needs_review (true/false), reviewer_notes (короткий комментарий если нашёл проблему).

КРИТЕРИИ (важно: порог ревью — 50%):
- Если код выглядит правильно для описания: confidence 80-100, needs_review: false.
- Если есть лёгкая неоднозначность, но код в правильной товарной группе: confidence 50-80, needs_review: false. Можешь добавить reviewer_notes для оператора, но НЕ помечай needs_review.
- Если код ЯВНО сомнительный или ЯВНО неправильный (например, мебель отнесли к сантехнике, или общее «配件/товар» без понимания материала): confidence < 50, needs_review: true, reviewer_notes объясни почему неправильно.
- Если ставка пошлины выглядит неверной для этого кода — отметь в reviewer_notes, но не флагай если код всё равно в правильной группе.

ВАЖНО: needs_review = true ТОЛЬКО при confidence < 50. Не флагай позиции с confidence ≥ 50.

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
      // Ground-truth description from the local ЕАЭС catalogue. If absent, the
      // code does not exist — Маке will hard-fail downstream, but reviewer should
      // still flag it for clarity.
      tnved_official_description: it.official_description ?? null,
      tnved_validation: it.validation_status,
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
        content: `Проверь работу классификатора. tnved_official_description — это РЕАЛЬНОЕ описание из ЕАЭС-номенклатуры; если оно по смыслу не совпадает с товаром, ставь confidence ниже 50 и needs_review=true.\n\n${inputJson}`,
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

  // Hard rule: needs_review fires only below CONFIDENCE_REVIEW_THRESHOLD. Anything
  // ≥ 50 ships without review even if the reviewer happens to flag it.
  const CONFIDENCE_REVIEW_THRESHOLD = 50;
  const byIndex = new Map(parsed.items.map((p) => [p.index, p]));
  return items.map((it) => {
    const r = byIndex.get(it.index);
    if (!r) {
      return {
        ...it,
        confidence: 70,
        needs_review: false,
        reviewer_notes: 'Проверяющий не вернул оценку',
      };
    }
    const needs_review = r.confidence < CONFIDENCE_REVIEW_THRESHOLD;
    return {
      ...it,
      confidence: r.confidence,
      needs_review,
      review_reason: needs_review ? r.reviewer_notes ?? 'Требует проверки' : undefined,
      reviewer_notes: r.reviewer_notes,
    };
  });
}

// -----------------------------------------------------------------------------
// АГЕНТ 4 — ЛАУРА (ФИНАНСИСТ / ТАМОЖЕННЫЙ КАЛЬКУЛЯТОР)
// -----------------------------------------------------------------------------
// Лаура — старший финансист-таможенник РК. Отвечает за стоимость, пошлину,
// НДС и таможенный сбор. Никогда не отпускает инвойс без стоимости.
//
// Логика расчёта детерминирована (это арифметика, не место для LLM-фантазии),
// но мы оборачиваем её в её отчёт с проверкой согласованности.

export type LauraPriceMode = 'TARGET_PAYMENTS' | 'PRICE_PER_KG' | 'CLIENT_PRICELIST' | 'KGD_INDICATIVE';

export interface PricedItem extends ReviewedItem {
  cost_usd: number;
  duty_usd: number;
  vat_usd: number;
}

export interface LauraReport {
  items: PricedItem[];
  totals: {
    gross_kg: number;
    net_kg: number;
    units: number;
    cost_usd: number;
    duty_usd: number;
    vat_usd: number;
    fee_usd: number;
    total_payments_usd: number;
    target_usd?: number;
  };
  notes: string;
}

// Конвертация KZT -> USD по таможенному курсу (упрощённо).
const KZT_PER_USD = 480;
const CUSTOMS_FEE_KZT = 26000;
const VAT_RATE = 0.16;
const DEFAULT_PRICE_PER_KG_LINEA = 0.75;

export function agentLaura(
  items: ReviewedItem[],
  mode: LauraPriceMode,
  value: number | undefined,
  defaultPricePerKg: number = DEFAULT_PRICE_PER_KG_LINEA,
): LauraReport {
  const t0 = Date.now();
  if (items.length === 0) {
    throw new Error('Лаура (Финансист): нет позиций для расчёта стоимости');
  }
  const grossTotal = items.reduce((s, i) => s + (i.gross_kg || 0), 0);
  const netTotal = items.reduce((s, i) => s + (i.net_kg || 0), 0);
  const unitsTotal = items.reduce((s, i) => s + (i.quantity || 0), 0);
  if (netTotal <= 0) {
    throw new Error('Лаура (Финансист): суммарный вес нетто = 0, расчёт невозможен');
  }

  const feeUsd = Math.round((CUSTOMS_FEE_KZT / KZT_PER_USD) * 100) / 100;

  // ---------- 1. Считаем общую стоимость партии ----------
  let totalCostUsd: number;
  let notes: string;
  if (mode === 'TARGET_PAYMENTS' && value && value > 0) {
    // Цель: чтобы итог платежей (пошлина+НДС+сбор) ≈ value.
    // Считаем средневзвешенную ставку пошлины по весу.
    const weightedDuty =
      items.reduce((s, i) => s + (i.duty_rate / 100) * (i.gross_kg || 0), 0) /
      Math.max(grossTotal, 1);
    const denom = weightedDuty + VAT_RATE * (1 + weightedDuty);
    totalCostUsd = Math.max(1, Math.round((value - feeUsd) / denom));
    notes = `Режим TARGET_PAYMENTS: цель платежей $${value}. Средняя ставка пошлины ${(weightedDuty * 100).toFixed(2)}%. Расчётная инвойсная стоимость партии: $${totalCostUsd}.`;
  } else if (mode === 'PRICE_PER_KG' && value && value > 0) {
    totalCostUsd = Math.round(netTotal * value);
    notes = `Режим PRICE_PER_KG: $${value}/кг × ${netTotal.toFixed(2)} кг нетто = $${totalCostUsd}.`;
  } else {
    totalCostUsd = Math.round(netTotal * defaultPricePerKg);
    notes = `Режим по умолчанию (прайс клиента): $${defaultPricePerKg}/кг × ${netTotal.toFixed(2)} кг нетто = $${totalCostUsd}.`;
  }

  // ---------- 2. Распределяем стоимость пропорционально нетто ----------
  let costSum = 0;
  const priced: PricedItem[] = items.map((it, idx) => {
    const isLast = idx === items.length - 1;
    const share = netTotal > 0 ? (it.net_kg || 0) / netTotal : 1 / items.length;
    let costItem = Math.round(totalCostUsd * share * 100) / 100;
    if (isLast) costItem = Math.round((totalCostUsd - costSum) * 100) / 100;
    costSum += costItem;
    const dutyItem = Math.round(costItem * (it.duty_rate / 100) * 100) / 100;
    const vatItem = Math.round((costItem + dutyItem) * VAT_RATE * 100) / 100;
    return { ...it, cost_usd: costItem, duty_usd: dutyItem, vat_usd: vatItem };
  });

  // ---------- 3. Итоги ----------
  const dutyUsd = Math.round(priced.reduce((s, i) => s + i.duty_usd, 0) * 100) / 100;
  const vatUsd = Math.round(priced.reduce((s, i) => s + i.vat_usd, 0) * 100) / 100;
  const totalPayments = Math.round((dutyUsd + vatUsd + feeUsd) * 100) / 100;

  if (totalCostUsd <= 0) {
    throw new Error('Лаура (Финансист): расчётная стоимость = 0, отказ отправлять инвойс');
  }

  logger.info(
    {
      ms: Date.now() - t0,
      mode,
      value,
      items: items.length,
      cost_usd: totalCostUsd,
      duty_usd: dutyUsd,
      vat_usd: vatUsd,
      fee_usd: feeUsd,
      total_payments: totalPayments,
    },
    'agent 4 Лаура done',
  );

  return {
    items: priced,
    totals: {
      gross_kg: grossTotal,
      net_kg: netTotal,
      units: unitsTotal,
      cost_usd: totalCostUsd,
      duty_usd: dutyUsd,
      vat_usd: vatUsd,
      fee_usd: feeUsd,
      total_payments_usd: totalPayments,
      target_usd: mode === 'TARGET_PAYMENTS' ? value : undefined,
    },
    notes,
  };
}

// -----------------------------------------------------------------------------
// АГЕНТ 5 — МАКЕ (ГЛАВНЫЙ ТАМОЖЕННЫЙ БРОКЕР, ФИНАЛЬНЫЙ ВЕРИФИКАТОР)
// -----------------------------------------------------------------------------
const MAKE_PROMPT = `Ты — Маке, главный таможенный брокер и финансист РК. Лучший в стране.
Твоя задача — финальная проверка инвойса перед отправкой клиенту. Без твоего одобрения инвойс не уходит.

ПРОВЕРЬ:
1. КОДЫ ТН ВЭД: каждый код — ровно 10 цифр, существует в ЕАЭС, соответствует описанию товара.
2. КАТЕГОРИЯ: основная группа товаров (по большинству позиций) согласована — если 80%+ позиций мебель (94хх), то это мебельная партия; не должно быть кода из совершенно чужой группы.
3. ВЕСА: брутто >= нетто; не должно быть позиций с весом 0 или явно абсурдным (>10 тонн на штуку).
4. ФИНАНСЫ:
   - Общая стоимость > $0 (категорически не пропускай инвойс без стоимости).
   - По каждой позиции: cost_usd > 0, duty_usd = cost_usd × duty_rate%, vat_usd = (cost_usd + duty_usd) × 16%.
   - Сбор таможенный = ~$54 (26 000 KZT).
   - Итоговые суммы сходятся.
5. ЦЕЛЬ: если оператор задал целевую сумму платежей, расчёт должен попадать в неё ±10%.

ВЫВОД — СТРОГО валидный JSON, без markdown:
{
  "approved": true,
  "warnings": ["Позиция #5: общее описание 'мебель' — стоит уточнить материал"],
  "make_notes": "Партия мебельная, 51 из 61 позиций в группе 94. Стоимость распределена корректно. Одобрено."
}

ВАЖНО:
- approved: false ставь ТОЛЬКО при критических ошибках (стоимость = 0, код не 10 цифр, итоги не сходятся).
- warnings — мягкие замечания, не блокируют отправку.
- make_notes — твой профессиональный вердикт 1-3 предложения.`;

export interface MakeVerdict {
  approved: boolean;
  warnings: string[];
  notes: string;
}

export async function agentMake(report: LauraReport): Promise<MakeVerdict> {
  const t0 = Date.now();
  const c = client();

  // Suммаризированный вход — не отправляем Маке весь сырой текст, только агрегаты.
  const codeBreakdown: Record<string, number> = {};
  for (const it of report.items) {
    const grp = it.tnved_code.slice(0, 2);
    codeBreakdown[grp] = (codeBreakdown[grp] ?? 0) + 1;
  }

  const inputJson = JSON.stringify({
    totals: report.totals,
    code_groups: codeBreakdown,
    sample_items: report.items.slice(0, 5).map((i) => ({
      index: i.index,
      text: i.text_translated,
      code: i.tnved_code,
      duty_rate: i.duty_rate,
      net_kg: i.net_kg,
      cost_usd: i.cost_usd,
      duty_usd: i.duty_usd,
      vat_usd: i.vat_usd,
    })),
    zero_cost_items: report.items.filter((i) => i.cost_usd <= 0).length,
    zero_weight_items: report.items.filter((i) => (i.net_kg || 0) <= 0).length,
  });

  const response = await c.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1500,
    system: [{ type: 'text', text: MAKE_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: `Дай финальное заключение по инвойсу:\n\n${inputJson}` },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Маке (Главный): пустой ответ');
  }
  const parsed = extractJson<{ approved: boolean; warnings?: string[]; make_notes?: string }>(textBlock.text);

  // Hard safety: never approve if cost is missing or any code failed catalogue validation.
  const hardFailures: string[] = [];
  if (report.totals.cost_usd <= 0) hardFailures.push('Стоимость инвойса = 0 — категорически нельзя отправлять.');
  if (report.items.some((i) => i.cost_usd <= 0)) hardFailures.push('Есть позиции с нулевой стоимостью.');

  // Hard-fail on codes that don't exist in the local ЕАЭС catalogue even after retry.
  const invalidCodeItems = report.items.filter((i) => i.validation_status === 'invalid');
  if (invalidCodeItems.length > 0) {
    const list = invalidCodeItems
      .slice(0, 5)
      .map((i) => `#${i.index} «${i.text_translated || i.text_original}» — ${i.tnved_code}`)
      .join('; ');
    const tail = invalidCodeItems.length > 5 ? ` (и ещё ${invalidCodeItems.length - 5})` : '';
    hardFailures.push(
      `Коды не существуют в ЕАЭС-номенклатуре: ${list}${tail}. Классификатор ошибся, инвойс отправлять нельзя.`,
    );
  }

  // Soft warning: suspicious ТН ВЭД suffixes (last 4 digits).
  // Known-safe endings used in ЕАЭС: 0000, 9000, 9009, 0009, 0008, 0090, 0099, 9900, 9909, 9990, 9999, 0001, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000.
  // Anything else (like 3009, 1009, 0050, 1090) is usually a hallucinated code.
  const SAFE_SUFFIXES = new Set([
    '0000', '0001', '0008', '0009', '0090', '0099',
    '1000', '2000', '3000', '4000', '5000', '6000', '7000', '8000',
    '9000', '9009', '9090', '9099', '9100', '9900', '9909', '9990', '9999',
  ]);
  const suspiciousCodes: string[] = [];
  for (const it of report.items) {
    if (!/^\d{10}$/.test(it.tnved_code)) continue;
    const suffix = it.tnved_code.slice(6);
    if (!SAFE_SUFFIXES.has(suffix)) {
      suspiciousCodes.push(`#${it.index} «${it.text_translated || it.text_original}» — ${it.tnved_code} (суффикс ${suffix} нестандартный, проверь по справочнику)`);
    }
  }
  if (suspiciousCodes.length > 0) {
    const head = `Подозрительные 10-значные суффиксы (${suspiciousCodes.length} шт) — нужна проверка брокером:`;
    parsed.warnings = [head, ...suspiciousCodes.slice(0, 10), ...(parsed.warnings ?? [])];
    if (suspiciousCodes.length > 10) parsed.warnings.push(`…и ещё ${suspiciousCodes.length - 10} позиций`);
  }

  // Lookup against accumulated operator/broker feedback in Supabase.
  // Codes marked 'bad' by humans in past invoices → strong warning.
  // Codes marked 'good' → not even worth flagging (broker has verified).
  const stats = await loadFeedbackStats().catch(() => new Map());
  const blacklisted: string[] = [];
  for (const it of report.items) {
    const s = stats.get(it.tnved_code);
    if (isLikelyBad(s)) {
      const alt = s!.suggested_alternatives[0]
        ? ` (брокер ранее предлагал: ${s!.suggested_alternatives[0]})`
        : '';
      blacklisted.push(`#${it.index} «${it.text_translated || it.text_original}» — ${it.tnved_code} помечен брокером как НЕВЕРНЫЙ ${s!.bad} раз${alt}`);
    }
  }
  if (blacklisted.length > 0) {
    parsed.warnings = [
      `🚩 Коды из чёрного списка брокера (${blacklisted.length} шт):`,
      ...blacklisted.slice(0, 10),
      ...(parsed.warnings ?? []),
    ];
  }

  const approved = parsed.approved && hardFailures.length === 0;

  logger.info(
    {
      ms: Date.now() - t0,
      approved,
      warnings: parsed.warnings?.length ?? 0,
      hard_failures: hardFailures.length,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    'agent 5 Маке done',
  );

  return {
    approved,
    warnings: [...(parsed.warnings ?? []), ...hardFailures],
    notes: parsed.make_notes ?? '',
  };
}

// -----------------------------------------------------------------------------
// ПОЛНЫЙ PIPELINE: Переводчик → Классификатор → Ревьюер → Лаура → Маке
// -----------------------------------------------------------------------------

export interface PipelineProgress {
  stage: 1 | 2 | 3 | 4 | 5;
  label: string;
}

export interface PipelineResult {
  items: PricedItem[];
  financials: LauraReport['totals'];
  laura_notes: string;
  make: MakeVerdict;
}

export async function runClassificationPipeline(
  fileText: string,
  options: {
    mode: LauraPriceMode;
    value?: number;
    defaultPricePerKg?: number;
  },
  onProgress?: (p: PipelineProgress) => void | Promise<void>,
): Promise<PipelineResult> {
  onProgress?.({ stage: 1, label: 'Агент 1: перевод и извлечение позиций...' });
  const translated = await agentTranslator(fileText);

  onProgress?.({ stage: 2, label: `Агент 2: подбор кодов ТН ВЭД (${translated.length} поз.)...` });
  const classified = await agentClassifier(translated);

  onProgress?.({ stage: 3, label: 'Агент 3: проверка работы классификатора...' });
  const reviewed = await agentReviewer(classified);

  onProgress?.({ stage: 4, label: 'Лаура (финансист): расчёт стоимости, пошлины, НДС...' });
  const laura = agentLaura(reviewed, options.mode, options.value, options.defaultPricePerKg);

  onProgress?.({ stage: 5, label: 'Маке (главный): финальная приёмка инвойса...' });
  const make = await agentMake(laura);

  if (!make.approved) {
    throw new Error(
      `Маке (Главный): инвойс не одобрен — ${make.warnings.join('; ') || 'без указания причины'}`,
    );
  }

  return {
    items: laura.items,
    financials: laura.totals,
    laura_notes: laura.notes,
    make,
  };
}
