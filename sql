-- =====================================================================
-- Rode este script INTEIRO no SQL Editor do Supabase
-- (Project > SQL Editor > New query > cole tudo > RUN).
-- É seguro rodar de novo quantas vezes quiser: não duplica nada.
-- Se você já tem dados, eles são mantidos.
-- IMPORTANTE: rode ANTES de subir o novo site e o novo bot.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1) Tabelas
-- ---------------------------------------------------------------------

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

-- ---------------------------------------------------------------------
-- 2) ANTI-DUPLICIDADE
-- ---------------------------------------------------------------------

-- 2a) Compras/movimentações: cada envio carrega um "client_id" único
--     (o site gera um por formulário; o bot usa o id da mensagem do Telegram).
--     Se o mesmo envio chegar duas vezes (duplo clique, reentrega do Telegram,
--     internet oscilando), o banco recusa a segunda e nada é duplicado.
--     Registros antigos ficam com client_id vazio, sem problema.
alter table transactions add column if not exists client_id text;
create unique index if not exists transactions_client_id_key on transactions (client_id);

-- 2b) Contas fixas: remove as duplicadas que já existem (mantém a mais antiga
--     de cada nome, ignorando maiúsculas/minúsculas e espaços nas pontas)...
delete from fixed_bills a
using fixed_bills b
where lower(btrim(a.name)) = lower(btrim(b.name))
  and (coalesce(a.created_at, 'epoch'::timestamptz), a.id)
    > (coalesce(b.created_at, 'epoch'::timestamptz), b.id);

--     ...e impede que voltem a existir duas contas com o mesmo nome.
create unique index if not exists fixed_bills_name_key on fixed_bills (lower(btrim(name)));

-- 2c) Valores precisam ser positivos (só vale para novos registros).
do $$
begin
  begin
    alter table transactions add constraint transactions_amount_positive check (amount > 0) not valid;
  exception when duplicate_object then null;
  end;
  begin
    alter table fixed_bills add constraint fixed_bills_amount_positive check (amount > 0) not valid;
  exception when duplicate_object then null;
  end;
end $$;

-- 2d) Parcelamento e vencimento das contas fixas.
--     - start_month: mês em que a conta passou a valer (as parcelas contam a partir daqui).
--       Contas que já existiam ganham o mês da criação; as novas usam o mês atual.
--     - installments_total: quantas parcelas tem. Vazio = conta recorrente, sem fim
--       (aluguel, assinatura, etc). Com número, é um parcelamento/dívida.
--     - due_day: dia do mês em que costuma vencer (1 a 31). Só informativo.
--     Quando as parcelas acabam, a conta some sozinha da lista de contas ativas
--     dos meses seguintes: o site e o bot calculam isso na hora (mês atual −
--     mês de início vs. total de parcelas), sem precisar de nenhuma tarefa
--     agendada rodando no servidor.
alter table fixed_bills add column if not exists start_month date;
update fixed_bills set start_month = date_trunc('month', coalesce(created_at, now()))::date where start_month is null;
alter table fixed_bills alter column start_month set default date_trunc('month', now())::date;
alter table fixed_bills alter column start_month set not null;

alter table fixed_bills add column if not exists installments_total int;
alter table fixed_bills add column if not exists due_day smallint;

do $$
begin
  begin
    alter table fixed_bills add constraint fixed_bills_installments_positive check (installments_total is null or installments_total > 0) not valid;
  exception when duplicate_object then null;
  end;
  begin
    alter table fixed_bills add constraint fixed_bills_due_day_range check (due_day is null or (due_day between 1 and 31)) not valid;
  exception when duplicate_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------
-- 3) Segurança (modo pessoal: acesso liberado pela chave anon)
--    Para exigir login no site, veja o bloco OPCIONAL no fim do arquivo.
-- ---------------------------------------------------------------------
alter table settings enable row level security;
alter table fixed_bills enable row level security;
alter table transactions enable row level security;

drop policy if exists "allow all settings" on settings;
create policy "allow all settings" on settings for all using (true) with check (true);

drop policy if exists "allow all fixed_bills" on fixed_bills;
create policy "allow all fixed_bills" on fixed_bills for all using (true) with check (true);

drop policy if exists "allow all transactions" on transactions;
create policy "allow all transactions" on transactions for all using (true) with check (true);

-- ---------------------------------------------------------------------
-- 4) Contas fixas iniciais: só entram se a tabela estiver VAZIA.
--    (Antes, rodar o script de novo duplicava as 6 contas.)
--    Edite os valores depois direto no site.
-- ---------------------------------------------------------------------
insert into fixed_bills (name, amount)
select v.name, v.amount
from (values
  ('Faculdade', 170),
  ('Plano de crédito', 30),
  ('Parcela do celular', 418),
  ('Tesouro Direto', 180),
  ('Cartão de crédito', 240),
  ('Programa', 32)
) as v(name, amount)
where not exists (select 1 from fixed_bills);

-- ---------------------------------------------------------------------
-- 5) Realtime: faz o site atualizar sozinho quando o bot registra algo.
-- ---------------------------------------------------------------------
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


-- =====================================================================
-- OPCIONAL A) Ver possíveis compras duplicadas que JÁ existem no banco
--    (mesmo tipo, valor, categoria e dia, criadas com até 2 min de diferença).
--    Copie só este SELECT, rode, confira e apague pelo site o que sobrar.
-- =====================================================================
-- select a.occurred_on, a.type, a.category, a.description, a.amount,
--        a.created_at as primeira, b.created_at as repetida, b.id as id_da_repetida
-- from transactions a
-- join transactions b
--   on a.id <> b.id
--  and a.type = b.type and a.amount = b.amount
--  and a.occurred_on = b.occurred_on
--  and coalesce(a.category,'') = coalesce(b.category,'')
--  and a.created_at < b.created_at
--  and b.created_at - a.created_at < interval '2 minutes'
-- order by a.occurred_on desc;


-- =====================================================================
-- OPCIONAL B) Exigir LOGIN para ver/alterar os dados
--    Hoje, quem descobrir o endereço do seu site consegue ler e mexer nas
--    suas finanças (a chave anon é pública). Para trancar:
--      1. Supabase > Authentication > Users > Add user (seu e-mail e senha)
--      2. Authentication > Sign In / Providers > desative "Allow new users to sign up"
--      3. No bot, troque SUPABASE_KEY pela chave "service_role"
--         (Project Settings > API). NUNCA coloque essa chave no site.
--      4. No index.html, mude  REQUIRE_LOGIN = false  para  true
--      5. Rode o bloco abaixo (tire os "-- " do início das linhas).
-- =====================================================================
-- drop policy if exists "allow all settings" on settings;
-- drop policy if exists "allow all fixed_bills" on fixed_bills;
-- drop policy if exists "allow all transactions" on transactions;
-- create policy "auth settings" on settings for all to authenticated using (true) with check (true);
-- create policy "auth fixed_bills" on fixed_bills for all to authenticated using (true) with check (true);
-- create policy "auth transactions" on transactions for all to authenticated using (true) with check (true);
