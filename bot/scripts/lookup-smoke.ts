import { validateCode, preloadDatabase } from '../src/services/tnved-lookup.js';
preloadDatabase();
const cases: Array<[string, string]> = [
  ['9506910000', 'инвалид (из 0096)'],
  ['9019109001', 'есть, но это ГИДРОМАССАЖНЫЕ — не палочка'],
  ['9504900009', 'инвалид'],
  ['9506990009', 'инвалид'],
  ['9403600009', 'инвалид'],
  ['9506290000', 'валидный SUP'],
  ['8302100000', 'валидные петли'],
  ['1234567890', 'мусор'],
  ['abc', 'не цифры'],
];
for (const [c, label] of cases) {
  const v = validateCode(c);
  if (v.valid) {
    console.log(`✅ ${c}  ${label}  →  ${v.official_description?.slice(0, 80)}`);
  } else {
    const sib6 = v.siblings_six?.length ?? 0;
    const sib4 = v.siblings_four?.length ?? 0;
    console.log(`❌ ${c}  ${label}  →  invalid (соседи 6-знач:${sib6}, 4-знач:${sib4})`);
  }
}
