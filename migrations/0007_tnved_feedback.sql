-- Накапливаемая база обратной связи по кодам ТН ВЭД.
-- Каждый раз когда оператор/брокер помечает код как «верный» или «неверный»
-- пишется строка. Маке агрегирует и использует:
--   - verdict='bad' с >= 2 голосами → код в чёрный список, классификатор должен избегать
--   - verdict='good' с >= 1 голосом → код в белый список, шлём без флага
create table if not exists tnved_feedback (
  id bigserial primary key,
  code text not null,
  verdict text not null check (verdict in ('good', 'bad')),
  -- Контекст: что был за товар когда этот код был назначен. Помогает
  -- отличать «код 9403600009 плох для тумбочки» vs «плох для дивана».
  context text,
  -- Откуда пришла обратная связь.
  invoice_id uuid references invoices(id) on delete set null,
  item_index integer,
  reported_by uuid references telegram_users(id) on delete set null,
  -- Альтернатива которую брокер считает правильной (для verdict='bad').
  suggested_code text,
  created_at timestamptz not null default now()
);

create index if not exists tnved_feedback_code_verdict_idx on tnved_feedback (code, verdict);
create index if not exists tnved_feedback_created_at_idx on tnved_feedback (created_at desc);

comment on table tnved_feedback is 'Operator/broker feedback on ТН ВЭД code correctness — feeds Маке validator';
