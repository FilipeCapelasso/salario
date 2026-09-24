-- Rode este script inteiro no SQL Editor do Supabase (Project > SQL Editor > New query > RUN)

create extension if not exists pgcrypto;

-- Salário e configurações gerais (uma única linha, id sempre = 1)
create table if not exists settings (
  id int primary key default 1,
  salary numeric(10,2) not null default 0,
  updated_at timestamptz default now()
);
insert into settings (id, salary) values (1, 2500) on conflict (id) do nothing;

-- Contas fixas mensais
create table if not exists fixed_bills (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  amount numeric(10,2) not null,
  active boolean not null default true,
  created_at timestamptz default now()
);

-- Movimentações: compras, retiradas, entradas, acréscimos
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('entrada','compra','retirada','acrescimo')),
  category text,
  description text,
  amount numeric(10,2) not null,
  occurred_on date not null default current_date,
  source text default 'site', -- 'site' ou 'telegram'
  created_at timestamptz default now()
);

create index if not exists transactions_occurred_on_idx on transactions (occurred_on);

-- Segurança: habilita RLS e libera acesso via chave anon (uso pessoal, single-user).
-- Se quiser mais segurança depois, troque estas policies por regras com autenticação.
alter table settings enable row level security;
alter table fixed_bills enable row level security;
alter table transactions enable row level security;

drop policy if exists "allow all settings" on settings;
create policy "allow all settings" on settings for all using (true) with check (true);

drop policy if exists "allow all fixed_bills" on fixed_bills;
create policy "allow all fixed_bills" on fixed_bills for all using (true) with check (true);

drop policy if exists "allow all transactions" on transactions;
create policy "allow all transactions" on transactions for all using (true) with check (true);

-- Suas 6 contas fixas atuais (edite valores depois direto no site se mudar)
insert into fixed_bills (name, amount) values
  ('Faculdade', 170),
  ('Plano de crédito', 30),
  ('Parcela do celular', 418),
  ('Tesouro Direto', 180),
  ('Cartão de crédito', 240),
  ('Programa', 32)
on conflict do nothing;

-- Ativa o Realtime nestas tabelas: é o que faz o site atualizar sozinho
-- quando o bot (ou você em outro dispositivo) registra algo. Seguro rodar
-- de novo caso já tenha rodado antes (ignora "já existe").
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table transactions';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table fixed_bills';
  exception when duplicate_object then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table settings';
  exception when duplicate_object then null;
  end;
end $$;
