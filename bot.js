require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.BOT_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente. Confira o .env (BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY).');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ============================================================
   CONFIGURAÇÃO — edite aqui à vontade
   ============================================================ */

// Fuso horário usado para "hoje" e "mês atual" (o servidor roda em UTC).
const TZ = process.env.TIMEZONE || 'America/Rio_Branco';

// Segurança: coloque seu chat id em ALLOWED_CHAT_ID (mais de um? separe por vírgula).
// Descubra o seu mandando qualquer mensagem ao bot e olhando os logs do servidor. Vazio = qualquer pessoa pode usar o bot.
const ALLOWED = (process.env.ALLOWED_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

// Tipos de lançamento. "defaults" são as categorias que sempre aparecem nos botões;
// as que você já usou antes (e que estão no banco) entram automaticamente depois delas.
// "Compra" cobre tanto gastos quanto retiradas de dinheiro (categoria "Retirada").
const TYPES = {
  compra:    { label: 'Compra',    emoji: '🛒', defaults: ['Almoço', 'Mercado', 'Lanche', 'Empréstimo', 'Software', 'Retirada'] },
  acrescimo: { label: 'Acréscimo', emoji: '➕', defaults: ['Bônus', 'Presente', 'Rendimento'] },
};

// Tipos antigos que podem existir no banco (de antes desta simplificação),
// só usados para não quebrar ao exibir lançamentos antigos.
const LEGACY_TYPES = { entrada: { label: 'Entrada', emoji: '📥' }, retirada: { label: 'Retirada', emoji: '💵' } };
const typeInfo = (type) => TYPES[type] || LEGACY_TYPES[type] || { label: cap(type), emoji: '•' };

const MAX_BUTTONS = 12;              // máximo de categorias nos botões
const PENDING_TTL = 10 * 60 * 1000;  // botões expiram em 10 min
const DUP_WINDOW_MS = 3 * 60 * 1000; // mesmo valor+categoria dentro de 3 min = "parece duplicada"

// Emojis por categoria (chave sem acento e minúscula). O resto usa 🏷️
const CATEGORY_EMOJI = {
  almoco: '🍽️', jantar: '🍽️', lanche: '🍔', mercado: '🛒', emprestimo: '🤝', software: '💻',
  retirada: '💵', bonus: '🎁', presente: '🎁', rendimento: '📈',
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

// Sem argumento = mês atual. Aceita "anterior", "-2" (2 meses atrás) ou "MM/AAAA".
// Retorna null se não entender.
function monthBounds(arg) {
  let { y, m } = nowParts();
  const s = String(arg || '').trim().toLowerCase();
  if (s) {
    let back = null;
    if (s === 'anterior' || s === 'passado') back = 1;
    else if (/^-\d{1,2}$/.test(s)) back = Math.abs(Number(s));
    if (back !== null) {
      const d = new Date(Date.UTC(y, m - 1 - back, 1));
      y = d.getUTCFullYear();
      m = d.getUTCMonth() + 1;
    } else {
      const mm = s.match(/^(\d{1,2})[/-](\d{4})$/);
      if (!mm || Number(mm[1]) < 1 || Number(mm[1]) > 12) return null;
      m = Number(mm[1]);
      y = Number(mm[2]);
    }
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}`, label: `${pad(m)}/${y}`, ym: `${y}-${pad(m)}` };
}

/* ---------- parcelas e vencimento das contas fixas ----------
   Mesma lógica do site: cada conta tem um mês de início (start_month) e,
   opcionalmente, um total de parcelas. Uma dívida quitada some sozinha das
   contas ativas dos meses seguintes — é só matemática de datas, calculada
   na hora, sem precisar de nenhuma tarefa agendada. */
const currentYm = () => { const { y, m } = nowParts(); return `${y}-${pad(m)}`; };
const ymToIndex = (s) => { const [y, m] = s.split('-').map(Number); return y * 12 + (m - 1); };
const indexToYmLabel = (idx) => `${pad((idx % 12) + 1)}/${Math.floor(idx / 12)}`;
function billStatus(b, ymStr) {
  const total = b.installments_total;
  const diff = ymToIndex(ymStr) - ymToIndex(String(b.start_month).slice(0, 7));
  const started = diff >= 0;
  const finished = total != null && diff >= total;
  const num = started && !finished ? diff + 1 : null;
  return { started, finished, num, diff };
}
function billLine(b, st) {
  if (!b.installments_total) return `• ${esc(b.name)}: <b>${brl(b.amount)}</b>`;
  const parc = st.num === b.installments_total ? 'última parcela' : `parcela ${st.num}/${b.installments_total}`;
  return `• ${esc(b.name)}: <b>${brl(b.amount)}</b> <i>(${parc})</i>`;
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
const newToken = () => crypto.randomBytes(4).toString('hex');
const sumOf = (list) => list.reduce((s, x) => s + Number(x.amount), 0);

// Detecta se um Acréscimo parece ser o salário mensal (para avisar
// que existe o campo fixo /salario, que evita lançar isso todo mês por engano).
const looksLikeSalary = (category, description) => /salario/.test(normKey(`${category || ''} ${description || ''}`));

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
      console.log(`Acesso negado para chat id: ${chatId}`);
      bot.sendMessage(chatId, '⛔ Acesso não autorizado.');
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

const cmd = (name) => new RegExp(`^\\/(?:${name})(?:@\\w+)?(?:\\s+([\\s\\S]+))?\\s*$`);
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
   BANCO + ANTI-DUPLICIDADE
   ============================================================

   Três camadas protegem contra lançamentos repetidos:
   1. client_id único: cada mensagem/toque tem uma chave (o banco recusa repetição).
      Cobre reentrega do Telegram, reinício do bot e toques duplos.
   2. Checagem de "parece duplicada": mesmo tipo + valor + categoria nos últimos
      3 minutos → o bot pergunta antes de gravar.
   3. Botão "Desfazer" em toda confirmação e o comando /desfazer.
*/

async function findByClientId(clientId) {
  const { data, error } = await sb.from('transactions').select('id').eq('client_id', clientId).limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function findRecentSimilar({ type, amount, category }) {
  const since = new Date(Date.now() - DUP_WINDOW_MS).toISOString();
  let q = sb.from('transactions').select('id').eq('type', type).eq('amount', amount).gte('created_at', since).limit(1);
  q = category ? q.eq('category', category) : q.is('category', null);
  const { data, error } = await q;
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// Retorna { status: 'saved', id } | { status: 'duplicate' } | { status: 'similar' }
async function commit(entry, { clientId, force = false }) {
  if (clientId && (await findByClientId(clientId))) return { status: 'duplicate' };
  if (!force && (await findRecentSimilar(entry))) return { status: 'similar' };

  const { data, error } = await sb.from('transactions').insert({
    type: entry.type,
    amount: entry.amount,
    category: entry.category || null,
    description: entry.description || null,
    occurred_on: todayISO(),
    source: 'telegram',
    client_id: clientId || null,
  }).select('id').single();

  if (error) {
    if (error.code === '23505') return { status: 'duplicate' }; // outra cópia chegou junto
    throw error;
  }
  return { status: 'saved', id: data && data.id };
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
  if (!clean) return null;
  const found = all.find((c) => normKey(c) === normKey(clean));
  return found || cap(clean);
}

/* ============================================================
   FLUXO DE REGISTRO COM BOTÕES
   ============================================================ */

const pending = new Map();        // token -> { kind: 'cat' | 'dup', chatId, ..., createdAt }
const awaitingCustom = new Map(); // chatId -> token

setInterval(() => {
  const now = Date.now();
  for (const [token, p] of pending) if (now - p.createdAt > PENDING_TTL) pending.delete(token);
}, 60 * 1000).unref();

function confirmText({ type, amount, category, description }) {
  let t = `✅ ${TYPES[type].label} de <b>${brl(amount)}</b> registrada.`;
  if (category) t += `\n🏷️ ${esc(cap(category))}`;
  if (description) t += `\n📝 ${esc(description)}`;
  return t;
}

const undoMarkup = (id) => ({ reply_markup: { inline_keyboard: [[{ text: '↩️ Desfazer', callback_data: `undo:${id}` }]] } });

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

// Grava com proteção e responde. `reply(texto, extra)` envia nova mensagem ou edita a existente.
async function finalize(entry, clientId, reply, { force = false, skipSalaryCheck = false } = {}) {
  // Acréscimo com cara de "salário" → confirma antes de gravar, porque
  // provavelmente o certo é usar o campo fixo (/salario), não um lançamento avulso.
  if (!skipSalaryCheck && entry.type === 'acrescimo' && looksLikeSalary(entry.category, entry.description)) {
    const token = newToken();
    pending.set(token, { kind: 'sal', entry, clientId, createdAt: Date.now() });
    return reply(
      `🤔 Isso parece ser o <b>salário</b>.\n\n` +
      `O campo <b>Salário</b> é fixo: você define uma vez (ou usa /salario) e ele entra <b>todo mês sozinho</b>, sem precisar lançar de novo. Já uma ${TYPES[entry.type].label.toLowerCase()} conta só neste mês, como um extra avulso.\n\n` +
      `Se <b>${brl(entry.amount)}</b> é o seu salário mensal (não um extra), o certo é ajustar o valor fixo — assim você evita lançar duas vezes por engano.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '👔 Definir como salário fixo', callback_data: `sal:${token}:edit` }],
            [{ text: '✅ Não, é um lançamento avulso mesmo', callback_data: `sal:${token}:yes` }],
          ],
        },
      }
    );
  }

  const r = await commit(entry, { clientId, force });

  if (r.status === 'saved') {
    return reply(confirmText(entry), r.id ? undoMarkup(r.id) : {});
  }
  if (r.status === 'duplicate') {
    return reply('ℹ️ Esse lançamento já estava registrado — não dupliquei.');
  }
  // similar: pergunta antes de gravar
  const token = newToken();
  pending.set(token, { kind: 'dup', entry, createdAt: Date.now() });
  const desc = `${TYPES[entry.type].emoji} ${TYPES[entry.type].label} de <b>${brl(entry.amount)}</b>` +
    (entry.category ? ` · ${esc(cap(entry.category))}` : '');
  return reply(
    `⚠️ <b>Parece duplicada.</b>\nJá registrei ${desc} nos últimos 3 minutos.\n\nRegistrar mesmo assim?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Sim, registrar', callback_data: `dup:${token}:yes` },
          { text: '❌ Não', callback_data: `dup:${token}:no` },
        ]],
      },
    }
  );
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
  const clientId = `msg:${chatId}:${msg.message_id}`; // mesma mensagem nunca grava duas vezes
  const reply = (text, extra = {}) => bot.sendMessage(chatId, text, { ...html, ...extra });

  const { buttons, all } = await categoryOptions(type);

  // Atalho: se a 1ª palavra depois do valor já é uma categoria conhecida, grava direto
  if (rest.length) {
    const match = all.find((c) => normKey(c) === normKey(rest[0]));
    if (match) {
      await finalize({ type, amount, category: match, description: rest.slice(1).join(' ') || null }, clientId, reply);
      return;
    }
  }

  const description = rest.join(' ') || null;
  const token = newToken();
  pending.set(token, { kind: 'cat', chatId, type, amount, description, buttons, all, createdAt: Date.now() });

  let text = `${cfg.emoji} ${cfg.label} de <b>${brl(amount)}</b>`;
  if (description) text += `\n📝 ${esc(description)}`;
  text += '\n\nEscolha a categoria:';
  await bot.sendMessage(chatId, text, { ...html, reply_markup: categoryKeyboard(token, buttons) });
}

bot.on('callback_query', async (q) => {
  const chatId = q.message && q.message.chat.id;
  const answer = (opts) => bot.answerCallbackQuery(q.id, opts).catch(() => {});
  try {
    const [kind, a, b] = String(q.data || '').split(':');
    if (!chatId || !['cat', 'dup', 'sal', 'undo', 'resumo'].includes(kind)) return answer();
    if (!authorized(chatId)) return answer({ text: 'Acesso não autorizado.', show_alert: true });

    const ref = { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML' };
    const edit = (text, extra = {}) => bot.editMessageText(text, { ...ref, ...extra });

    /* ---- "Ver resumo completo" a partir do /saldo ---- */
    if (kind === 'resumo') {
      await answer();
      await sendSummary(chatId);
      return;
    }

    /* ---- desfazer ---- */
    if (kind === 'undo') {
      if (a === 'keep') {
        await answer();
        await edit('👍 Mantida.');
        return;
      }
      const { data: rows, error } = await sb.from('transactions').delete().eq('id', a).select('type, amount, category');
      if (error) throw error;
      if (!rows || !rows.length) {
        await answer({ text: 'Já tinha sido removido.' });
        await edit('ℹ️ Esse lançamento já tinha sido removido.');
        return;
      }
      const t = rows[0];
      await answer({ text: 'Desfeito.' });
      await edit(`🗑️ Desfeito: ${typeInfo(t.type).label} de <b>${brl(t.amount)}</b>${t.category ? ' · ' + esc(cap(t.category)) : ''}`);
      return;
    }

    const p = pending.get(a);
    const valid = p && p.kind === kind && (kind === 'dup' || kind === 'sal' || p.chatId === chatId);
    if (!valid) {
      await answer({ text: 'Essa seleção expirou. Envie o comando de novo.', show_alert: true });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
      return;
    }

    /* ---- "parece salário": usar o campo fixo ou lançar mesmo assim ---- */
    if (kind === 'sal') {
      pending.delete(a); // um toque só
      if (b === 'edit') {
        const { error } = await sb.from('settings').update({ salary: p.entry.amount, updated_at: new Date().toISOString() }).eq('id', 1);
        if (error) throw error;
        await answer({ text: 'Salário atualizado.' });
        await edit(`👔 Salário fixo definido para <b>${brl(p.entry.amount)}</b>.\nA partir de agora ele entra sozinho todo mês — não precisa lançar de novo (nada foi registrado como ${TYPES[p.entry.type].label.toLowerCase()}).`);
        return;
      }
      await answer({ text: 'Registrando…' });
      await finalize(p.entry, p.clientId, edit, { skipSalaryCheck: true });
      return;
    }

    /* ---- "parece duplicada": confirmar ou não ---- */
    if (kind === 'dup') {
      pending.delete(a); // um toque só
      if (b !== 'yes') {
        await answer();
        await edit('❌ Não registrei.');
        return;
      }
      await answer({ text: 'Registrando…' });
      await finalize(p.entry, `cb:${a}`, edit, { force: true });
      return;
    }

    /* ---- escolha de categoria ---- */
    if (b === 'cancel') {
      pending.delete(a);
      awaitingCustom.delete(chatId);
      await answer();
      await edit('❌ Cancelado.');
      return;
    }

    if (b === 'new') {
      awaitingCustom.set(chatId, a);
      await answer();
      await edit(`✏️ ${TYPES[p.type].label} de <b>${brl(p.amount)}</b>\n\nDigite o nome da nova categoria, ou toque em ❌ Cancelar acima:`);
      return;
    }

    let category = null;
    if (b !== 'none') {
      category = p.buttons[Number(b)];
      if (!category) return answer();
    }

    pending.delete(a); // evita registrar duas vezes se tocar 2x
    awaitingCustom.delete(chatId);
    await answer({ text: 'Registrando…' });
    await finalize({ type: p.type, amount: p.amount, category, description: p.description }, `cb:${a}`, edit);
  } catch (e) {
    console.error(e);
    answer({ text: 'Erro. Tente de novo.', show_alert: true });
    if (chatId) bot.sendMessage(chatId, '⚠️ Não consegui registrar: ' + (e.message || e)).catch(() => {});
  }
});

// Texto digitado depois de "✏️ Outra (digitar)" vira a nova categoria.
// Mensagem que começa com número (ex.: "45,90 mercado") vira uma compra.
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || !authorized(chatId)) return;

  if (msg.text.startsWith('/')) {
    awaitingCustom.delete(chatId); // qualquer comando cancela a digitação
    return;
  }

  try {
    const token = awaitingCustom.get(chatId);
    if (token) {
      awaitingCustom.delete(chatId);
      const p = pending.get(token);
      if (!p || p.kind !== 'cat') {
        await bot.sendMessage(chatId, 'Essa seleção expirou. Envie o comando de novo.');
        return;
      }
      const category = canonicalCategory(msg.text, p.all);
      if (!category) {
        await bot.sendMessage(chatId, 'Categoria vazia. Envie o comando de novo.');
        return;
      }
      pending.delete(token);
      const reply = (text, extra = {}) => bot.sendMessage(chatId, text, { ...html, ...extra });
      await finalize({ type: p.type, amount: p.amount, category, description: p.description }, `cb:${token}`, reply);
      return;
    }

    if (/^\s*(?:r\$\s*)?\d/i.test(msg.text)) {
      await handleRegister(msg, 'compra', msg.text);
    }
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
<code>/compra [valor] [descrição]</code> — registra uma compra ou retirada
<code>/acrescimo [valor] [descrição]</code> — registra um valor a mais

<b>Consultar</b>
<code>/saldo</code> — saldo rápido do mês com barrinha
<code>/resumo</code> — resumo completo linha a linha

<b>Configurar</b>
<code>/conta [nome] [valor]</code> — cria ou atualiza uma conta fixa
<code>/conta Celular 418 12x</code> — parcelada em 12x (some sozinha ao quitar)
<code>/salario [valor]</code> — altera o salário fixo

💡 Mande só um número (ex.: <code>45,90</code>) que já vira uma compra. Errou? Toque em ↩️ Desfazer na confirmação.`;

bot.onText(/^\/(start|ajuda|help)(?:@\w+)?\s*$/, guarded((msg) => bot.sendMessage(msg.chat.id, HELP, html)));

for (const type of Object.keys(TYPES)) {
  bot.onText(cmd(type), guarded((msg, match) => {
    if (!match[1] || !match[1].trim()) {
      return bot.sendMessage(msg.chat.id, `Informe o valor. Exemplo: /${type} 45,90`);
    }
    return handleRegister(msg, type, match[1]);
  }));
}

/* ---------- /desfazer ---------- */

bot.onText(cmd('desfazer'), guarded(async (msg) => {
  const { data, error } = await sb.from('transactions').select('*').order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const t = data && data[0];
  if (!t) {
    await bot.sendMessage(msg.chat.id, 'Não há nenhuma movimentação para desfazer.');
    return;
  }
  const cfg = typeInfo(t.type);
  const extra = [t.category ? cap(t.category) : null, t.description].filter(Boolean).map(esc).join(' — ');
  await bot.sendMessage(
    msg.chat.id,
    `Excluir a última movimentação?\n\n${fmtDay(t.occurred_on)} · ${cfg.emoji} ${cfg.label} · <b>${brl(t.amount)}</b>${extra ? '\n' + extra : ''}`,
    {
      ...html,
      reply_markup: {
        inline_keyboard: [[
          { text: '🗑️ Excluir', callback_data: `undo:${t.id}` },
          { text: 'Manter', callback_data: 'undo:keep' },
        ]],
      },
    }
  );
}));

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

// Calcula os totais do mês (salário fixo + entradas/acréscimos − contas fixas −
// compras). Usada pelo /resumo e pelo /saldo, pra garantir que os dois SEMPRE
// mostrem o mesmo número — sem risco de "conflito" entre eles.
async function computeMonthTotals(monthArg) {
  const bounds = monthBounds(monthArg);
  if (!bounds) return null;
  const { start, end, ym } = bounds;
  const [s, b, t] = await Promise.all([
    sb.from('settings').select('salary').eq('id', 1).single(),
    sb.from('fixed_bills').select('*'),
    sb.from('transactions').select('type, category, description, amount, occurred_on, created_at')
      .gte('occurred_on', start).lte('occurred_on', end)
      .order('occurred_on', { ascending: true }).order('created_at', { ascending: true }),
  ]);
  const err = s.error || b.error || t.error;
  if (err) throw err;

  const salary = s.data ? Number(s.data.salary) : 0;
  const billRows = (b.data || [])
    .map((x) => ({ b: x, st: billStatus(x, ym) }))
    .filter((r) => r.b.active && r.st.started && !r.st.finished)
    .sort((x, y) => x.b.name.localeCompare(y.b.name, 'pt-BR'));
  const bills = billRows.map((r) => r.b);
  const txs = t.data || [];
  // "retirada" e "entrada" são tipos antigos (de antes do /compra e /acrescimo
  // absorverem tudo); lançamentos antigos com esses tipos ainda entram na conta.
  const compras = txs.filter((x) => x.type === 'compra' || x.type === 'retirada');
  const acrescimos = txs.filter((x) => x.type === 'acrescimo' || x.type === 'entrada');

  const totalBills = sumOf(bills);
  const totAcrescimos = sumOf(acrescimos);
  const totCompras = sumOf(compras);
  const saldo = salary + totAcrescimos - totCompras - totalBills;

  return { bounds, salary, billRows, bills, totalBills, acrescimos, compras, totAcrescimos, totCompras, saldo };
}

async function sendSummary(chatId, monthArg) {
  const calc = await computeMonthTotals(monthArg);
  if (!calc) {
    await bot.sendMessage(chatId, 'Não entendi o mês. Exemplos: /resumo, /resumo anterior, /resumo 08/2026');
    return;
  }
  const {
    bounds: { label }, salary, billRows, acrescimos, compras,
    totalBills, totAcrescimos, totCompras, saldo,
  } = calc;

  const billsLines = [`📌 <b>CONTAS FIXAS</b>`];
  if (!billRows.length) billsLines.push('— nenhuma conta fixa —');
  else billRows.forEach((r) => billsLines.push(billLine(r.b, r.st)));
  billsLines.push(`Total: <b>${brl(totalBills)}</b>`);

  const closing = [
    `🧮 <b>FECHAMENTO</b>`,
    `👔 Salário: + ${brl(salary)}`,
    `➕ Acréscimos: + ${brl(totAcrescimos)}`,
    `📌 Contas fixas: − ${brl(totalBills)}`,
    `🛒 Compras: − ${brl(totCompras)}`,
    `━━━━━━━━━━━━━━`,
    `💰 <b>Restante: ${brl(saldo)}</b>`,
  ];
  if (saldo < 0) closing.push('⚠️ Você está no negativo neste mês.');

  await sendBlocks(chatId, [
    `📊 <b>RESUMO DE ${label}</b>`,
    `👔 <b>SALÁRIO</b> <i>(fixo, todo mês)</i>\n<b>${brl(salary)}</b>`,
    billsLines.join('\n'),
    txSection('ACRÉSCIMOS', '➕', acrescimos, false),
    txSection('COMPRAS', '🛒', compras, true),
    closing.join('\n'),
  ]);
}

bot.onText(cmd('resumo'), guarded((msg, match) => sendSummary(msg.chat.id, match[1])));

/* ---------- /saldo ---------- */

function progressBar(pctSpent) {
  const clamped = Math.max(0, Math.min(100, pctSpent));
  const filled = Math.round(clamped / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

async function sendSaldo(chatId) {
  const calc = await computeMonthTotals();
  if (!calc) {
    await bot.sendMessage(chatId, 'Não consegui calcular o saldo agora.');
    return;
  }
  const { bounds: { label }, salary, totAcrescimos, totCompras, totalBills, saldo } = calc;
  const income = salary + totAcrescimos;
  const saidas = totalBills + totCompras;
  const pctGasto = income > 0 ? (saidas / income) * 100 : (saidas > 0 ? 100 : 0);
  const pctLivre = Math.round(Math.max(0, 100 - pctGasto));

  let text =
    `💰 <b>SALDO DE ${label}</b>\n\n` +
    `👔 Salário: ${brl(salary)}\n` +
    `➕ Acréscimos: + ${brl(totAcrescimos)}\n` +
    `📌🛒 Contas + compras: − ${brl(saidas)}\n` +
    `━━━━━━━━━━━━━━\n` +
    `💰 <b>Saldo: ${brl(saldo)}</b>\n\n` +
    `${progressBar(pctGasto)} ${Math.round(Math.min(100, pctGasto))}% usado\n` +
    `🚀 <b>${pctLivre}% de renda livre</b>`;
  if (saldo < 0) text += '\n\n⚠️ Você está no negativo neste mês.';

  await bot.sendMessage(chatId, text, {
    ...html,
    reply_markup: { inline_keyboard: [[{ text: '📊 Ver resumo completo', callback_data: 'resumo:show' }]] },
  });
}

bot.onText(cmd('saldo'), guarded((msg) => sendSaldo(msg.chat.id)));

/* ---------- /contas e /conta ---------- */

bot.onText(cmd('contas'), guarded(async (msg) => {
  const { data: all, error } = await sb.from('fixed_bills').select('*')
    .order('created_at', { ascending: true }).order('name', { ascending: true });
  if (error) throw error;
  const ym = currentYm();
  const rows = (all || []).map((b) => ({ b, st: billStatus(b, ym) }));
  const active = rows.filter((r) => r.b.active && r.st.started && !r.st.finished);
  const upcoming = rows.filter((r) => r.b.active && !r.st.started);
  if (!active.length && !upcoming.length) {
    await bot.sendMessage(msg.chat.id,
      'Nenhuma conta fixa ativa.\nUse /conta Nome 50,00 para criar (ou "12x" para parcelar).');
    return;
  }
  active.sort((a, z) => a.b.name.localeCompare(z.b.name, 'pt-BR'));
  let text = `📌 <b>CONTAS FIXAS</b>\n${active.map((r) => billLine(r.b, r.st)).join('\n') || '— nenhuma conta ativa —'}\n\nTotal: <b>${brl(sumOf(active.map((r) => r.b)))}</b>`;
  if (upcoming.length) {
    text += `\n\n🔜 <i>Começam em breve:</i>\n` +
      upcoming.map((r) => `• ${esc(r.b.name)}: ${brl(r.b.amount)} — a partir de ${indexToYmLabel(ymToIndex(String(r.b.start_month).slice(0, 7)))}`).join('\n');
  }
  await bot.sendMessage(msg.chat.id, text, html);
}));

// Cria a conta OU atualiza o valor se o nome já existir (nunca duplica).
// Aceita parcelas ("12x") depois do valor.
bot.onText(cmd('conta'), guarded(async (msg, match) => {
  const chatId = msg.chat.id;
  const m = (match[1] || '').trim().match(/^(.+?)\s+(?:R\$\s*)?([\d.,]+)(?:\s+([\s\S]*))?$/i);
  const amount = m ? parseAmount(m[2]) : NaN;
  if (!m || !validAmount(amount)) {
    await bot.sendMessage(chatId,
      'Uso: /conta Nome valor [Nx]\n\n' +
      'Exemplos:\n• /conta Netflix 39,90\n• /conta Celular 418 12x\n\n' +
      'Se a conta já existir, você atualiza o valor (ou reinicia um parcelamento, se a anterior já tiver sido quitada).', html);
    return;
  }
  const name = m[1].trim().replace(/\s+/g, ' ').slice(0, 60);
  const extra = m[3] || '';
  const mi = extra.match(/(\d{1,3})\s*x\b/i);
  const installments_total = mi ? parseInt(mi[1], 10) : null;
  if (installments_total != null && (installments_total < 1 || installments_total > 600)) {
    await bot.sendMessage(chatId, 'Número de parcelas inválido.');
    return;
  }

  const ym = currentYm();
  const { data: all, error } = await sb.from('fixed_bills').select('*');
  if (error) throw error;
  const found = (all || []).find((b) => normKey(b.name) === normKey(name));

  if (found) {
    const st = billStatus(found, ym);
    if (st.finished) {
      const { error: e2 } = await sb.from('fixed_bills').update({
        amount, active: true, start_month: ym + '-01', installments_total,
      }).eq('id', found.id);
      if (e2) throw e2;
      await bot.sendMessage(chatId,
        `🔁 <b>${esc(found.name)}</b> estava quitada — novo parcelamento iniciado: <b>${brl(amount)}</b>` +
        (installments_total ? ` em ${installments_total}x` : '') + '.', html);
      return;
    }
    const patch = { amount, active: true };
    if (mi) patch.installments_total = installments_total;
    const { error: e2 } = await sb.from('fixed_bills').update(patch).eq('id', found.id);
    if (e2) throw e2;
    const same = Number(found.amount) === amount && found.active && !mi;
    await bot.sendMessage(chatId, same
      ? `ℹ️ <b>${esc(found.name)}</b> já existe com esse valor (${brl(amount)}). Nada mudou.`
      : `🔄 <b>${esc(found.name)}</b> atualizada: ${brl(found.amount)} → <b>${brl(amount)}</b>`, html);
    return;
  }

  const { error: e3 } = await sb.from('fixed_bills').insert({ name, amount, start_month: ym + '-01', installments_total });
  if (e3) {
    if (e3.code === '23505') {
      await bot.sendMessage(chatId, 'ℹ️ Essa conta já existe. Mande o comando de novo para atualizar o valor.');
      return;
    }
    throw e3;
  }
  const extra2 = installments_total ? `${installments_total}x` : '';
  await bot.sendMessage(chatId, `📌 Conta fixa <b>${esc(name)}</b> criada: <b>${brl(amount)}</b>/mês${extra2 ? ' · ' + extra2 : ''}.`, html);
}));

/* ---------- /salario ---------- */

bot.onText(cmd('salario'), guarded(async (msg, match) => {
  const chatId = msg.chat.id;
  if (!match[1] || !match[1].trim()) {
    const { data, error } = await sb.from('settings').select('salary').eq('id', 1).single();
    if (error) throw error;
    await bot.sendMessage(chatId,
      `👔 <b>Salário fixo:</b> ${brl(data ? data.salary : 0)}\n\n` +
      `Para alterar: <code>/salario 2800</code>\nSaldo do mês: /saldo`,
      html);
    return;
  }
  const amount = parseAmount(match[1].trim());
  if (!Number.isFinite(amount) || amount < 0 || amount >= 100000000) {
    await bot.sendMessage(chatId, 'Não entendi o valor. Exemplo: /salario 2800');
    return;
  }
  const { error } = await sb.from('settings').update({ salary: amount, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw error;
  await bot.sendMessage(chatId, `👔 Salário fixo atualizado para <b>${brl(amount)}</b>.`, html);
}));

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */

bot.setMyCommands([
  { command: 'compra', description: 'Registrar compra ou retirada' },
  { command: 'acrescimo', description: 'Registrar um valor a mais' },
  { command: 'saldo', description: 'Saldo rápido do mês' },
  { command: 'resumo', description: 'Resumo completo do mês' },
  { command: 'conta', description: 'Criar/atualizar conta fixa' },
  { command: 'salario', description: 'Ver ou alterar o salário' },
  { command: 'ajuda', description: 'Lista de comandos' },
]).catch((e) => console.error('setMyCommands:', e.message));

// Servidor HTTP mínimo: o Render (web service gratuito) exige uma porta aberta
// e só mantém o serviço acordado se receber requisições (use um pinger, veja o README).
const PORT = process.env.PORT || 3000;
const server = http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot online ✅');
  })
  .listen(PORT, () => console.log(`Servidor HTTP na porta ${PORT}`));

let warned409 = false;
bot.on('polling_error', (e) => {
  console.error('polling_error:', e.code || '', e.message);
  if (!warned409 && /409/.test(String(e.message))) {
    warned409 = true;
    console.error('⚠️  Há OUTRA cópia do bot rodando com este mesmo token (outro deploy, seu PC, outro serviço). Desligue as extras para evitar respostas duplicadas.');
    // Avisa direto no Telegram (não só no log do servidor) — é o "conflito" que causa
    // respostas em dobro: normalmente é um `node bot.js` esquecido rodando no PC
    // junto com o deploy no Render/Railway, ou dois serviços de deploy ativos.
    for (const id of ALLOWED) {
      bot.sendMessage(id,
        '⚠️ <b>Duas cópias do bot rodando ao mesmo tempo</b> (mesmo token) — por isso as respostas estão vindo em dobro.\n\n' +
        'Confira: um <code>node bot.js</code> esquecido rodando no seu PC, ou dois serviços de deploy ativos (Render/Railway) com o mesmo BOT_TOKEN. Desligue a cópia extra.',
        html).catch(() => {});
    }
  }
});
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

// Desliga limpo em deploys/reinícios (evita duas cópias respondendo ao mesmo tempo)
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} recebido, encerrando…`);
  server.close();
  bot.stopPolling({ cancel: true }).catch(() => {}).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (ALLOWED.length === 0) {
  console.warn('⚠️  ALLOWED_CHAT_ID não definido: qualquer pessoa que achar o bot pode usá-lo. Mande qualquer mensagem ao bot, veja o chat id nos logs e configure ALLOWED_CHAT_ID.');
  bot.on('message', (msg) => console.log(`Chat id recebido: ${msg.chat.id}`));
}
console.log('Bot rodando (polling)...');
