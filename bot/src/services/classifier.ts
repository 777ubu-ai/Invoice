import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const SYSTEM_PROMPT = `Ты — эксперт по таможенной классификации товаров для импорта в Казахстан (ТН ВЭД ЕАЭС).

Для каждой позиции packing list определи:
- tnved_code: 10-значный код ТН ВЭД ЕАЭС
- tnved_description: описание товарной группы из ТН ВЭД на русском (короткое)
- duty_rate: ставка таможенной пошлины в процентах (число)
- confidence: уверенность 0-100
- needs_review: true если confidence < 80
- reasoning: обоснование выбора кода на русском, 2-3 предложения. Объясни как ты понял что это за товар (артикул, иероглифы, описание) и почему отнёс к этой группе ТН ВЭД.
- alternatives: 2-3 альтернативных кода с описанием для рассмотрения оператором

Опорные группы для сантехники и фитингов:
- 6910 — изделия санитарно-гигиенические из керамики (фарфор), ставка ~12%
- 7307 — фитинги для труб из чёрных металлов, ~5%
- 7324 — изделия санитарно-технические из чёрных металлов, ~10%
- 7412 — фитинги для труб из меди и медных сплавов, ~3%
- 7415 — гайки, болты, шурупы из меди, ~5%
- 3917 — трубы и фитинги из пластмасс, ~6.5%
- 8481 — краны, клапаны, вентили, ~5%

Распознавай китайские иероглифы:
- 陶瓷 = керамика/фарфор
- 不锈钢 = нержавеющая сталь
- 黄铜 = латунь
- 钢制 = стальной
- 球阀 = шаровой кран
- 弯头 = отвод
- 配件 = фитинг
- 管件 = фитинги для труб

Будь критичен: если описание абстрактное (просто "金属配件" = "металлический фитинг" без указания материала), занижай confidence до 60-75% и помечай needs_review.

Возвращай СТРОГО валидный JSON по схеме output_config.`;

export interface ItemToClassify {
  index: number;
  article: string;
  text_original: string;
  quantity: number;
  gross_kg: number;
}

export interface ClassifiedItem {
  index: number;
  tnved_code: string;
  tnved_description: string;
  duty_rate: number;
  confidence: number;
  needs_review: boolean;
  reasoning: string;
  alternatives: { code: string; description: string }[];
}

// Used when we have a full packing-list file (xlsx text dump) and want Claude
// to both extract items AND classify them in one pass.
export interface ExtractedClassifiedItem extends ClassifiedItem {
  article: string;
  text_original: string;
  text_translated: string;
  quantity: number;
  gross_kg: number;
  net_kg: number;
}

const FILE_SYSTEM_PROMPT = `Ты — эксперт по таможенной классификации товаров для импорта в Казахстан (ТН ВЭД ЕАЭС) и парсер packing list от китайских поставщиков.

Тебе дают текстовое представление xlsx-файла (строки и колонки в формате "R{N}: c1 | c2 | ..."). Структура колонок заранее НЕ известна — ты сам определяешь.

ЗАДАЧИ:
1. Найди строку-заголовок (часто R1 или R2-R5). Определи какие колонки содержат:
   - Артикул / номер позиции (часто 序号, No., Article, 货号)
   - Наименование товара (часто 品名, 名称, Name, Description, 中文名称)
   - Количество штук (часто 数量, Qty, PCS)
   - Вес брутто, кг (часто 毛重, Gross Weight, G.W.)
   - Вес нетто, кг (часто 净重, Net Weight, N.W.)
   - Количество мест (часто 件数, 箱数, Packages, CTN)

2. Извлеки данные построчно. Пропусти заголовки, итоговые строки (ИТОГО / TOTAL / 合计), пустые.

3. Если веса нетто нет — net_kg = gross_kg * 0.95.
   Если веса брутто нет — gross_kg = net_kg / 0.95.
   Если ни того ни другого — оставь 0.

4. Для каждой позиции присвой 10-значный код ТН ВЭД ЕАЭС с обоснованием на русском.

Распознавай китайские иероглифы и контекст:
- 家具 = мебель (группа 9403)
- 木 = деревянный
- 金属 = металл / 不锈钢 = нержавейка / 黄铜 = латунь / 钢制 = сталь
- 陶瓷 = керамика / 玻璃 = стекло / 塑料 PP = пластик
- 球阀 = кран, 弯头 = отвод, 配件/管件 = фитинги
- 服装 = одежда, 鞋 = обувь, 电子 = электроника

Основные группы ТН ВЭД ЕАЭС для импорта из Китая в Казахстан:
- 9403 — мебель прочая, ставка ~15%
- 9401 — мебель для сидения, ~15%
- 6910 — сантехника фарфоровая, ~12%
- 7307 — фитинги стальные, ~5%
- 7324 — сантехника стальная, ~10%
- 7412 — фитинги медные, ~3%
- 3917 — фитинги пластиковые, ~6.5%
- 8481 — краны / клапаны, ~5%
- 6109 — футболки трикотажные, ~12%
- 8517 — телефоны / коммуникационное оборудование, ~0-5%
- 8528 — мониторы / телевизоры, ~5-10%
- 6402 — обувь с резиновой подошвой, ~15%

Будь критичен: confidence < 80% если описание неоднозначное (нет указания материала, размытое название), помечай needs_review: true.

ВЫВОД — СТРОГО валидный JSON, без markdown-блоков, без преамбулы:
{
  "items": [
    {
      "index": 1,
      "article": "артикул из файла или сгенерированный",
      "text_original": "оригинал из строки",
      "text_translated": "русский перевод",
      "quantity": 100,
      "gross_kg": 200,
      "net_kg": 190,
      "tnved_code": "9403600009",
      "tnved_description": "Мебель деревянная прочая",
      "duty_rate": 15,
      "confidence": 92,
      "needs_review": false,
      "reasoning": "В описании 家具 (мебель) + материал 木 (дерево). Группа 9403 60 — мебель деревянная прочая.",
      "alternatives": [{"code": "...", "description": "..."}]
    }
  ]
}`;

export function isClaudeEnabled(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export async function classifyWithClaude(
  items: ItemToClassify[],
): Promise<ClassifiedItem[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });

  const itemsList = items
    .map(
      (it) =>
        `${it.index}. Артикул: ${it.article}\n   Текст: ${it.text_original}\n   Количество: ${it.quantity} шт, брутто: ${it.gross_kg} кг`,
    )
    .join('\n\n');

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          `Классифицируй следующие позиции packing list. Верни СТРОГО валидный JSON, без markdown-блоков, без преамбулы:\n\n${itemsList}\n\n` +
          `Формат ответа:\n` +
          `{"items":[{"index":1,"tnved_code":"...","tnved_description":"...","duty_rate":12,"confidence":95,"needs_review":false,"reasoning":"...","alternatives":[{"code":"...","description":"..."}]}]}`,
      },
    ],
  });

  const ms = Date.now() - t0;
  logger.info(
    {
      ms,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens,
      cache_create: response.usage.cache_creation_input_tokens,
      items: items.length,
    },
    'claude classification complete',
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response');
  }

  // Strip any markdown fencing Claude might add despite instructions.
  const raw = textBlock.text.trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error(`Could not locate JSON object in response: ${raw.slice(0, 200)}`);
  }
  const jsonText = raw.slice(jsonStart, jsonEnd + 1);

  const parsed = JSON.parse(jsonText) as { items: ClassifiedItem[] };
  return parsed.items;
}

// One-shot: send raw text dump of an xlsx file and let Claude both extract
// items AND classify them. Use this when we have a real uploaded packing list.
export async function extractAndClassifyFromText(
  fileText: string,
): Promise<ExtractedClassifiedItem[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });

  const t0 = Date.now();
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: FILE_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          `Вот текстовое представление packing list. Извлеки позиции и классифицируй каждую по ТН ВЭД. Верни JSON по схеме из system prompt.\n\n` +
          fileText,
      },
    ],
  });

  const ms = Date.now() - t0;
  logger.info(
    {
      ms,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read: response.usage.cache_read_input_tokens,
      cache_create: response.usage.cache_creation_input_tokens,
    },
    'claude extract+classify complete',
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response');
  }

  const raw = textBlock.text.trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error(`Could not locate JSON object in response: ${raw.slice(0, 200)}`);
  }
  const jsonText = raw.slice(jsonStart, jsonEnd + 1);
  const parsed = JSON.parse(jsonText) as { items: ExtractedClassifiedItem[] };
  return parsed.items;
}
