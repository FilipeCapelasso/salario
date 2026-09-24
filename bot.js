require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.BOT_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente. Confira o .env (veja .env.example).');
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const todayISO = () => new Date().toISOString().slice(0, 10);
const monthBounds = () => {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const start = new Date(y, m, 1).toISOString().slice(0, 10);
  const end = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  return { start, end, label: `${String(m + 1).padStart(2, '0')}/${y}` };
};

function parseAmount(str) {
  return parseFloat(String(str || '0').replace(',', '.'));
}

async function addTransaction(chatId, type, amount, category, description) {
  if (!amount || amount <= 0) {
    bot.sendMessage(chatId, 'Não entendi o valor. Exemplo: /compra 50 mercado compras da semana');
    return;
  }
  const { error } = await sb.from('transactions').insert({
    type, amount, category, description, occurred_on: todayISO(), source: 'telegram',
  });
  if (error) {
    bot.sendMessage(chatId, '⚠️ Erro ao salvar: ' + error.message);
    return;
  }
  const labels = { entrada: 'Entrada', compra: 'Compra', retirada: 'Retirada', acrescimo: 'Acréscimo' };
  bot.sendMessage(chatId, `✅ ${labels[type]} de R$ ${amount.toFixed(2)}${category ? ' (' + category + ')' : ''} registrada.`);
}

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`Olá! Comandos disponíveis:

/compra valor categoria descrição
/retirada valor descrição
/entrada valor categoria descrição
/acrescimo valor categoria descrição

/saldo — resumo do mês
/extrato — últimas 10 movimentações
/contas — contas fixas cadastradas

Exemplo: /compra 45,90 mercado feira da semana`);
});

bot.onText(/^\/compra (.+)/, (msg, match) => {
  const parts = match[1].split(' ');
  addTransaction(msg.chat.id, 'compra', parseAmount(parts[0]), parts[1] || null, parts.slice(2).join(' ') || null);
});

bot.onText(/^\/entrada (.+)/, (msg, match) => {
  const parts = match[1].split(' ');
  addTransaction(msg.chat.id, 'entrada', parseAmount(parts[0]), parts[1] || null, parts.slice(2).join(' ') || null);
});

bot.onText(/^\/acrescimo (.+)/, (msg, match) => {
  const parts = match[1].split(' ');
  addTransaction(msg.chat.id, 'acrescimo', parseAmount(parts[0]), parts[1] || null, parts.slice(2).join(' ') || null);
});

bot.onText(/^\/retirada (.+)/, (msg, match) => {
  const parts = match[1].split(' ');
  addTransaction(msg.chat.id, 'retirada', parseAmount(parts[0]), null, parts.slice(1).join(' ') || null);
});

bot.onText(/^\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  const { start, end, label } = monthBounds();
  const [{ data: settings }, { data: bills }, { data: txs }] = await Promise.all([
    sb.from('settings').select('salary').eq('id', 1).single(),
    sb.from('fixed_bills').select('amount').eq('active', true),
    sb.from('transactions').select('type, amount').gte('occurred_on', start).lte('occurred_on', end),
  ]);

  const salary = settings ? Number(settings.salary) : 0;
  const totalBills = (bills || []).reduce((s, b) => s + Number(b.amount), 0);
  const sum = (t) => (txs || []).filter((x) => x.type === t).reduce((s, x) => s + Number(x.amount), 0);
  const entradas = sum('entrada'), acrescimos = sum('acrescimo'), compras = sum('compra'), retiradas = sum('retirada');
  const saldo = salary + entradas + acrescimos - compras - retiradas - totalBills;

  bot.sendMessage(chatId,
`📊 Resumo de ${label}
Salário: R$ ${salary.toFixed(2)}
Contas fixas: R$ ${totalBills.toFixed(2)}
Entradas: R$ ${entradas.toFixed(2)}
Acréscimos: R$ ${acrescimos.toFixed(2)}
Compras: R$ ${compras.toFixed(2)}
Retiradas: R$ ${retiradas.toFixed(2)}

💰 Saldo estimado: R$ ${saldo.toFixed(2)}`);
});

bot.onText(/^\/extrato/, async (msg) => {
  const { data: txs } = await sb.from('transactions').select('*').order('created_at', { ascending: false }).limit(10);
  if (!txs || !txs.length) { bot.sendMessage(msg.chat.id, 'Nenhuma movimentação ainda.'); return; }
  const labels = { entrada: 'Entrada', compra: 'Compra', retirada: 'Retirada', acrescimo: 'Acréscimo' };
  const lines = txs.map((t) => `${t.occurred_on} · ${labels[t.type]} · R$ ${Number(t.amount).toFixed(2)}${t.category ? ' (' + t.category + ')' : ''}`);
  bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/^\/contas/, async (msg) => {
  const { data: bills } = await sb.from('fixed_bills').select('*').eq('active', true);
  if (!bills || !bills.length) { bot.sendMessage(msg.chat.id, 'Nenhuma conta fixa cadastrada.'); return; }
  const lines = bills.map((b) => `${b.name}: R$ ${Number(b.amount).toFixed(2)}`);
  const total = bills.reduce((s, b) => s + Number(b.amount), 0);
  bot.sendMessage(msg.chat.id, lines.join('\n') + `\n\nTotal: R$ ${total.toFixed(2)}`);
});

console.log('Bot rodando (polling)...');
