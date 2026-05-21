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
