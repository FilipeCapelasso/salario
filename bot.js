require('dotenv').config();
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.BOT_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente. Confira o .env (BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY).');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* ============================================================
   CONFIGURAÇÃO — edite aqui à vontade
   ============================================================ */

// Fuso horário usado para "hoje" e "mês atual" (o servidor do Railway roda em UTC).
const TZ = process.env.TIMEZONE || 'America/Rio_Branco';

// Segurança: coloque seu chat id em ALLOWED_CHAT_ID (mais de um? separe por vírgula).
// Descubra o seu mandando /id para o bot. Vazio = qualquer pessoa pode usar o bot.
const ALLOWED = (process.env.ALLOWED_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

// Tipos de lançamento. "defaults" são as categorias que sempre aparecem nos botões;
// as que você já usou antes (e que estão no banco) entram automaticamente depois delas.
const TYPES = {
  compra:    { label: 'Compra',    emoji: '🛒', askCategory: true,  defaults: ['Almoço', 'Mercado', 'Lanche', 'Empréstimo', 'Software'] },
  entrada:   { label: 'Entrada',   emoji: '📥', askCategory: true,  defaults: ['Freela', 'Venda', 'Reembolso'] },
  acrescimo: { label: 'Acréscimo', emoji: '➕', askCategory: true,  defaults: ['Bônus', 'Presente', 'Rendimento'] },
  retirada:  { label: 'Retirada',  emoji: '💵', askCategory: false, defaults: [] },
};

const MAX_BUTTONS = 12;            // máximo de categorias nos botões
const PENDING_TTL = 10 * 60 * 1000; // botões expiram em 10 min

// Emojis por categoria (chave sem acento e minúscula). O resto usa 🏷️
const CATEGORY_EMOJI = {
  almoco: '🍽️', jantar: '🍽️', lanche: '🍔', mercado: '🛒', emprestimo: '🤝', software: '💻',
  freela: '💼', venda: '💰', reembolso: '↩️', bonus: '🎁', presente: '🎁', rendimento: '📈',
  transporte: '🚌', saude: '💊', lazer: '🎮', jogos: '🎮', assinatura: '🔁',
};

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

const pad = (n) => String(n).padStart(2, '0');

function nowParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const todayISO = () => {
  const { y, m, d } = nowParts();
  return `${y}-${pad(m)}-${pad(d)}`;
};

function monthBounds() {
  const { y, m } = nowParts();
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}`, label: `${pad(m)}/${y}` };
}

const fmtDay = (iso) => {
  const [, m, d] = String(iso).split('-');
  return `${d}/${m}`;
};

const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const normKey = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const cap = (s) => (s ? s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1) : s);
const emojiFor = (cat) => CATEGORY_EMOJI[normKey(cat)] || '🏷️';

// Aceita "45", "45,90", "45.90", "1.234,56", "R$45"
function parseAmount(str) {
  if (!str) return NaN;
  let s = String(str).replace(/R\$/i, '').replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s)) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

const validAmount = (n) => n > 0 && n < 100000000;

const authorized = (chatId) => ALLOWED.length === 0 || ALLOWED.includes(String(chatId));

// Envolve um handler: checa autorização e captura erros
function guarded(fn) {
  return async (msg, match) => {
    const chatId = msg.chat.id;
    if (!authorized(chatId)) {
      bot.sendMessage(chatId, '⛔ Acesso não autorizado. Mande /id para ver o seu chat id.');
      return;
    }
    try {
      await fn(msg, match);
    } catch (e) {
      console.error(e);
      bot.sendMessage(chatId, '⚠️ Erro: ' + (e.message || e));
    }
  };
}

const cmd = (name) => new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s+([\\s\\S]+))?\\s*$`);
const html = { parse_mode: 'HTML' };

// Envia vários blocos respeitando o limite de 4096 caracteres do Telegram
async function sendBlocks(chatId, blocks) {
  const LIMIT = 3800;
  let cur = '';
  const flush = async () => {
    if (cur.trim()) await bot.sendMessage(chatId, cur, html);
    cur = '';
  };
  for (const block of blocks) {
    if (block.length <= LIMIT) {
      if (cur && cur.length + 2 + block.length > LIMIT) await flush();
      cur += (cur ? '\n\n' : '') + block;
    } else {
      await flush();
      for (const line of block.split('\n')) {
        if (cur && cur.length + 1 + line.length > LIMIT) await flush();
        cur += (cur ? '\n' : '') + line;
      }
    }
  }
  await flush();
}

/* ============================================================
   BANCO
   ============================================================ */

async function saveTransaction({ type, amount, category, description }) {
  const { error } = await sb.from('transactions').insert({
    type,
    amount,
    category: category || null,
    description: description || null,
    occurred_on: todayISO(),
    source: 'telegram',
  });
  if (error) throw error;
}

// Categorias para os botões: as padrão + as que você já usou nesse tipo (mais usadas primeiro)
async function categoryOptions(type) {
  const defaults = TYPES[type].defaults;
  const { data, error } = await sb
    .from('transactions')
    .select('category')
    .eq('type', type)
    .not('category', 'is', null)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;

  const used = new Map(); // chave -> { name, count }
  for (const row of data || []) {
    const name = (row.category || '').trim();
    if (!name) continue;
    const key = normKey(name);
    const cur = used.get(key) || { name, count: 0 };
    cur.count += 1;
    used.set(key, cur);
  }

  const all = [];
  const seen = new Set();
  // Se a categoria padrão já existe no histórico, mantém a grafia do histórico (evita duplicar no site)
  for (const d of defaults) {
    const key = normKey(d);
    all.push(used.has(key) ? used.get(key).name : d);
    seen.add(key);
  }
  const extras = [...used.entries()].filter(([k]) => !seen.has(k)).sort((a, b) => b[1].count - a[1].count);
  for (const [, v] of extras) all.push(v.name);

  return { buttons: all.slice(0, MAX_BUTTONS), all };
}

function canonicalCategory(name, all) {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  const found = all.find((c) => normKey(c) === normKey(clean));
  return found || cap(clean);
}

/* ============================================================
   FLUXO DE REGISTRO COM BOTÕES
   ============================================================ */

const pending = new Map();        // token -> { chatId, type, amount, description, buttons, all, createdAt }
const awaitingCustom = new Map(); // chatId -> token

setInterval(() => {
  const now = Date.now();
  for (const [token, p] of pending) if (now - p.createdAt > PENDING_TTL) pending.delete(token);
}, 60 * 1000).unref();

function confirmText(type, amount, category, description) {
  let t = `✅ ${TYPES[type].label} de <b>${brl(amount)}</b> registrada.`;
  if (category) t += `\n🏷️ ${esc(cap(category))}`;
  if (description) t += `\n📝 ${esc(description)}`;
  return t;
}

function categoryKeyboard(token, buttons) {
  const rows = [];
  let row = [];
  buttons.forEach((c, i) => {
    row.push({ text: `${emojiFor(c)} ${cap(c)}`, callback_data: `cat:${token}:${i}` });
    if (row.length === 2) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);
  rows.push([{ text: '✏️ Outra (digitar)', callback_data: `cat:${token}:new` }]);
  rows.push([
    { text: 'Sem categoria', callback_data: `cat:${token}:none` },
    { text: '❌ Cancelar', callback_data: `cat:${token}:cancel` },
  ]);
  return { inline_keyboard: rows };
}

async function handleRegister(msg, type, args) {
  const chatId = msg.chat.id;
  const cfg = TYPES[type];
  const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length && /^r\$$/i.test(tokens[0])) tokens.shift();

  const amount = parseAmount(tokens[0]);
  if (!validAmount(amount)) {
    await bot.sendMessage(chatId, `Não entendi o valor. Exemplo: /${type} 45,90`);
    return;
  }
  const rest = tokens.slice(1);

  // Retirada: sem categoria, grava direto
  if (!cfg.askCategory) {
    const description = rest.join(' ') || null;
    await saveTransaction({ type, amount, category: null, description });
    await bot.sendMessage(chatId, confirmText(type, amount, null, description), html);
    return;
  }

  const { buttons, all } = await categoryOptions(type);

  // Atalho: se a 1ª palavra depois do valor já é uma categoria conhecida, grava direto
  if (rest.length) {
    const match = all.find((c) => normKey(c) === normKey(rest[0]));
    if (match) {
      const description = rest.slice(1).join(' ') || null;
      await saveTransaction({ type, amount, category: match, description });
      await bot.sendMessage(chatId, confirmText(type, amount, match, description), html);
      return;
    }
  }

  const description = rest.join(' ') || null;
  const token = crypto.randomBytes(4).toString('hex');
  pending.set(token, { chatId, type, amount, description, buttons, all, createdAt: Date.now() });

  let text = `${cfg.emoji} ${cfg.label} de <b>${brl(amount)}</b>`;
  if (description) text += `\n📝 ${esc(description)}`;
  text += '\n\nEscolha a categoria:';
  await bot.sendMessage(chatId, text, { ...html, reply_markup: categoryKeyboard(token, buttons) });
}

bot.on('callback_query', async (q) => {
  const chatId = q.message && q.message.chat.id;
  try {
    if (!q.data || !q.data.startsWith('cat:') || !chatId) {
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (!authorized(chatId)) {
      await bot.answerCallbackQuery(q.id, { text: 'Acesso não autorizado.', show_alert: true });
      return;
    }

    const [, token, action] = q.data.split(':');
    const ref = { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML' };
    const p = pending.get(token);

    if (!p || p.chatId !== chatId) {
      await bot.answerCallbackQuery(q.id, { text: 'Essa seleção expirou. Envie o comando de novo.', show_alert: true });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    if (action === 'cancel') {
      pending.delete(token);
      awaitingCustom.delete(chatId);
      await bot.answerCallbackQuery(q.id);
      await bot.editMessageText('❌ Cancelado.', ref);
      return;
    }

    if (action === 'new') {
      awaitingCustom.set(chatId, token);
      await bot.answerCallbackQuery(q.id);
      await bot.editMessageText(
        `✏️ ${TYPES[p.type].label} de <b>${brl(p.amount)}</b>\n\nDigite o nome da nova categoria (ou /cancelar):`,
        ref
      );
      return;
    }

    let category = null;
    if (action !== 'none') {
      category = p.buttons[Number(action)];
      if (!category) {
        await bot.answerCallbackQuery(q.id);
        return;
      }
    }

    pending.delete(token); // evita registrar duas vezes se tocar 2x
    awaitingCustom.delete(chatId);
    try {
      await saveTransaction({ type: p.type, amount: p.amount, category, description: p.description });
    } catch (e) {
      console.error(e);
      await bot.answerCallbackQuery(q.id, { text: 'Erro ao salvar. Envie o comando de novo.', show_alert: true });
      await bot.editMessageText('⚠️ Erro ao salvar: ' + esc(e.message || e), ref);
      return;
    }
    await bot.answerCallbackQuery(q.id, { text: 'Registrado!' });
    await bot.editMessageText(confirmText(p.type, p.amount, category, p.description), ref);
  } catch (e) {
    console.error(e);
    bot.answerCallbackQuery(q.id).catch(() => {});
  }
});

// Texto digitado depois de "✏️ Outra (digitar)" vira a nova categoria
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || !authorized(chatId)) return;

  if (msg.text.startsWith('/')) {
    awaitingCustom.delete(chatId); // qualquer comando cancela a digitação
    return;
  }

  const token = awaitingCustom.get(chatId);
  if (!token) return;
  awaitingCustom.delete(chatId);

  const p = pending.get(token);
  if (!p) {
    bot.sendMessage(chatId, 'Essa seleção expirou. Envie o comando de novo.');
    return;
  }

  try {
    const category = canonicalCategory(msg.text, p.all);
    if (!category) {
      bot.sendMessage(chatId, 'Categoria vazia. Envie o comando de novo.');
      return;
    }
    pending.delete(token);
    await saveTransaction({ type: p.type, amount: p.amount, category, description: p.description });
    await bot.sendMessage(chatId, confirmText(p.type, p.amount, category, p.description), html);
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, '⚠️ Erro ao salvar: ' + (e.message || e));
  }
});

/* ============================================================
   COMANDOS
   ============================================================ */

const HELP = `👋 <b>Comandos</b>

<b>Registrar</b>
/compra 45,90 — você escolhe a categoria nos botões
/entrada 300 — idem
/acrescimo 150 — idem
/retirada 100 caixa eletrônico

💡 Já sabe a categoria? Mande junto:
/compra 45,90 mercado feira da semana
Se escrever outra coisa depois do valor, vira descrição e eu pergunto a categoria.

<b>Consultar</b>
/resumo — resumo completo do mês
/extrato — últimas 10 movimentações
/contas — contas fixas
/cancelar — cancela uma digitação em andamento
/id — mostra o seu chat id`;

bot.onText(/^\/(start|ajuda|help)(?:@\w+)?\s*$/, guarded((msg) => bot.sendMessage(msg.chat.id, HELP, html)));

bot.onText(/^\/id(?:@\w+)?\s*$/, (msg) => {
  bot.sendMessage(msg.chat.id, `Seu chat id: <code>${msg.chat.id}</code>`, html);
});

bot.onText(/^\/cancelar(?:@\w+)?\s*$/, guarded(async (msg) => {
  awaitingCustom.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, '❌ Cancelado.');
}));

for (const type of Object.keys(TYPES)) {
  bot.onText(cmd(type), guarded((msg, match) => handleRegister(msg, type, match[1])));
  // sem valor: mostra como usar
  bot.onText(new RegExp(`^\\/${type}(?:@\\w+)?\\s*$`), guarded((msg) =>
    bot.sendMessage(msg.chat.id, `Informe o valor. Exemplo: /${type} 45,90`)));
}

/* ---------- /resumo (e /saldo) ---------- */

function txLine(t) {
  const bits = [];
  if (t.category) bits.push(esc(cap(t.category)));
  if (t.description) bits.push(esc(t.description));
  const label = bits.length ? bits.join(' — ') : 'Sem descrição';
  return `• ${fmtDay(t.occurred_on)} · ${label} · <b>${brl(t.amount)}</b>`;
}

function categoryTotals(list) {
  const map = new Map();
  for (const t of list) {
    const key = t.category ? normKey(t.category) : '';
    const cur = map.get(key) || { name: t.category ? cap(t.category) : 'Sem categoria', total: 0 };
    cur.total += Number(t.amount);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

const sumOf = (list) => list.reduce((s, x) => s + Number(x.amount), 0);

function txSection(title, emoji, list, withCategories) {
  const lines = [`${emoji} <b>${title}</b>`];
  if (!list.length) {
    lines.push('— nenhum lançamento —');
  } else {
    list.forEach((t) => lines.push(txLine(t)));
    if (withCategories) {
      lines.push('');
      lines.push('<i>Por categoria:</i>');
      categoryTotals(list).forEach((c) => lines.push(`   ↳ ${esc(c.name)}: ${brl(c.total)}`));
    }
  }
  lines.push(`Total: <b>${brl(sumOf(list))}</b>`);
  return lines.join('\n');
}

async function sendSummary(chatId) {
  const { start, end, label } = monthBounds();
  const [s, b, t] = await Promise.all([
    sb.from('settings').select('salary').eq('id', 1).single(),
    sb.from('fixed_bills').select('name, amount').eq('active', true)
      .order('created_at', { ascending: true }).order('name', { ascending: true }),
    sb.from('transactions').select('type, category, description, amount, occurred_on, created_at')
      .gte('occurred_on', start).lte('occurred_on', end)
      .order('occurred_on', { ascending: true }).order('created_at', { ascending: true }),
  ]);
  const err = s.error || b.error || t.error;
  if (err) throw err;

  const salary = s.data ? Number(s.data.salary) : 0;
  const bills = b.data || [];
  const txs = t.data || [];
  const by = (type) => txs.filter((x) => x.type === type);
  const entradas = by('entrada'), acrescimos = by('acrescimo'), compras = by('compra'), retiradas = by('retirada');

  const totalBills = sumOf(bills);
  const totEntradas = sumOf(entradas), totAcrescimos = sumOf(acrescimos);
  const totCompras = sumOf(compras), totRetiradas = sumOf(retiradas);
  const saldo = salary + totEntradas + totAcrescimos - totCompras - totRetiradas - totalBills;

  const billsLines = [`📌 <b>CONTAS FIXAS</b>`];
  if (!bills.length) billsLines.push('— nenhuma conta fixa —');
  else bills.forEach((x) => billsLines.push(`• ${esc(x.name)}: <b>${brl(x.amount)}</b>`));
  billsLines.push(`Total: <b>${brl(totalBills)}</b>`);

  const closing = [
    `🧮 <b>FECHAMENTO</b>`,
    `Salário: + ${brl(salary)}`,
    `Entradas: + ${brl(totEntradas)}`,
    `Acréscimos: + ${brl(totAcrescimos)}`,
    `Contas fixas: − ${brl(totalBills)}`,
    `Compras: − ${brl(totCompras)}`,
    `Retiradas: − ${brl(totRetiradas)}`,
    `━━━━━━━━━━━━━━`,
    `💰 <b>Restante: ${brl(saldo)}</b>`,
  ];
  if (saldo < 0) closing.push('⚠️ Você está no negativo neste mês.');

  await sendBlocks(chatId, [
    `📊 <b>RESUMO DE ${label}</b>`,
    `💼 <b>SALÁRIO</b>\n<b>${brl(salary)}</b>`,
    billsLines.join('\n'),
    txSection('ENTRADAS', '📥', entradas, false),
    txSection('ACRÉSCIMOS', '➕', acrescimos, false),
    txSection('COMPRAS', '🛒', compras, true),
    txSection('RETIRADAS', '💵', retiradas, false),
    closing.join('\n'),
  ]);
}

bot.onText(/^\/(resumo|saldo)(?:@\w+)?\s*$/, guarded((msg) => sendSummary(msg.chat.id)));

/* ---------- /extrato ---------- */

bot.onText(/^\/extrato(?:@\w+)?\s*$/, guarded(async (msg) => {
  const { data: txs, error } = await sb.from('transactions').select('*')
    .order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  if (!txs || !txs.length) {
    await bot.sendMessage(msg.chat.id, 'Nenhuma movimentação ainda.');
    return;
  }
  const lines = txs.map((t) => {
    const cfg = TYPES[t.type] || { emoji: '•', label: t.type };
    const sign = t.type === 'entrada' || t.type === 'acrescimo' ? '+' : '−';
    const extra = [t.category ? cap(t.category) : null, t.description].filter(Boolean).map(esc).join(' — ');
    return `${fmtDay(t.occurred_on)} · ${cfg.emoji} ${cfg.label} · <b>${sign} ${brl(t.amount)}</b>${extra ? '\n      ' + extra : ''}`;
  });
  await sendBlocks(msg.chat.id, ['🧾 <b>ÚLTIMAS MOVIMENTAÇÕES</b>\n' + lines.join('\n')]);
}));

/* ---------- /contas ---------- */

bot.onText(/^\/contas(?:@\w+)?\s*$/, guarded(async (msg) => {
  const { data: bills, error } = await sb.from('fixed_bills').select('*').eq('active', true)
    .order('created_at', { ascending: true }).order('name', { ascending: true });
  if (error) throw error;
  if (!bills || !bills.length) {
    await bot.sendMessage(msg.chat.id, 'Nenhuma conta fixa cadastrada.');
    return;
  }
  const lines = bills.map((x) => `• ${esc(x.name)}: <b>${brl(x.amount)}</b>`);
  await bot.sendMessage(msg.chat.id,
    `📌 <b>CONTAS FIXAS</b>\n${lines.join('\n')}\n\nTotal: <b>${brl(sumOf(bills))}</b>`, html);
}));

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */

bot.setMyCommands([
  { command: 'compra', description: 'Registrar compra (escolhe a categoria)' },
  { command: 'entrada', description: 'Registrar entrada' },
  { command: 'acrescimo', description: 'Registrar acréscimo' },
  { command: 'retirada', description: 'Registrar retirada' },
  { command: 'resumo', description: 'Resumo completo do mês' },
  { command: 'extrato', description: 'Últimas 10 movimentações' },
  { command: 'contas', description: 'Contas fixas' },
  { command: 'ajuda', description: 'Lista de comandos' },
]).catch((e) => console.error('setMyCommands:', e.message));

bot.on('polling_error', (e) => console.error('polling_error:', e.code || '', e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

if (ALLOWED.length === 0) {
  console.warn('⚠️  ALLOWED_CHAT_ID não definido: qualquer pessoa que achar o bot pode usá-lo. Mande /id ao bot e configure.');
}
console.log('Bot rodando (polling)...');
