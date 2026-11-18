import { readFile, stat } from 'node:fs/promises';

export type CompanyProfile = { name: string; fields: {label: string; value: string}[] };

export async function loadCompanyProfile(path: string): Promise<CompanyProfile> {
  if (!path || (await stat(path)).size > 100_000) throw new Error('profile_unavailable');
  const raw: unknown = JSON.parse(await readFile(path,'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('invalid_profile');
  const p = raw as Record<string,unknown>;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 500 || !Array.isArray(p.fields) || p.fields.length < 1 || p.fields.length > 50) throw new Error('invalid_profile');
  const fields = p.fields.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_profile');
    const x = item as Record<string,unknown>;
    if (typeof x.label !== 'string' || !x.label.trim() || x.label.length > 200 || typeof x.value !== 'string' || !x.value.trim() || x.value.length > 3000) throw new Error('invalid_profile');
    return {label:x.label.trim(),value:x.value.trim()};
  });
  return {name:p.name.trim(),fields};
}

export function companySummary(profile: CompanyProfile): string {
  let result = `Покупатель / получатель: ${profile.name}\n\n`;
  for (const field of profile.fields) {
    const part = `${field.label}: ${field.value}\n`;
    if (result.length + part.length > 3500) return result + '\nПолные реквизиты будут в Excel.';
    result += part;
  }
  return result;
}
