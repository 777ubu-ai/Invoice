import { money } from './invoice-draft.js';

// Integer arithmetic with explicit units: quantities and weights use up to six
// decimal places; currency allocations use integer cents.
export function scaled(value:string,places=6):bigint {
  const s=value.trim().replace(',','.');
  const m=s.match(/^(\d{1,12})(?:\.(\d+))?$/);
  if(!m)throw new Error('Введите неотрицательное число.');
  const f=m[2]??'';if(f.length>places)throw new Error(`Допустимо не более ${places} знаков после запятой.`);
  return BigInt(m[1]!)*10n**BigInt(places)+BigInt((f+'0'.repeat(places)).slice(0,places)||'0');
}
export function cents(value:string):bigint {return scaled(value,2);}
function decimalAt(n:bigint,places:number):string {const scale=10n**BigInt(places),a=n/scale,b=String(n%scale).padStart(places,'0').replace(/0+$/,'');return b?`${a}.${b}`:String(a);}
export function lineAmount(quantity:string,price:string):string {
 const q=scaled(quantity),p=scaled(price,10);if(!q)throw new Error('Количество должно быть больше нуля.');
 const den=10000000000000000n;return money((q*p*100n+den/2n)/den);
}
export function priceForAmount(quantity:string,amount:string):string {
 const q=scaled(quantity),v=cents(amount);if(!q)throw new Error('Количество должно быть больше нуля.');
 for(let places=2;places<=10;places++){const p=(v*10n**BigInt(places+4)+q/2n)/q;const display=decimalAt(p,places);if(lineAmount(quantity,display)===money(v))return display;}
 throw new Error('Невозможно представить точную сумму позиции с этой точностью цены. Уточните цену или количество.');
}
// Hamilton apportionment preserves the total down to a cent and is deterministic.
export function allocate(total:string,weights:string[]):string[] {
 const target=cents(total),v=weights.map(x=>scaled(x));const totalWeight=v.reduce((a,b)=>a+b,0n);
 if(!totalWeight)throw new Error('Для распределения нужны положительные исходные стоимости или веса.');
 const parts=v.map((weight,index)=>({index,amount:target*weight/totalWeight,remainder:target*weight%totalWeight}));
 let remaining=target-parts.reduce((a,p)=>a+p.amount,0n);
 const order=[...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
 for(let i=0;remaining>0n;i++,remaining--)order[i]!.amount++;
 return parts.map(p=>money(p.amount));
}
export function amountByWeight(rate:string,weights:string[]):string {
 const r=scaled(rate);const w=weights.reduce((a,b)=>a+scaled(b),0n);if(!r||!w)throw new Error('Цена за килограмм и вес должны быть больше нуля.');
 const den=1000000000000n;return money((r*w*100n+den/2n)/den);
}
