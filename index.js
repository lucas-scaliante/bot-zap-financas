const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const app = express();
app.get('/', (req, res) => res.send('✅ Bot do Telegram rodando!'));
app.listen(process.env.PORT || 3000);

const bot = new Telegraf((process.env.TELEGRAM_TOKEN || '').trim());
const genAI = new GoogleGenerativeAI((process.env.GEMINI_API_KEY || '').trim());
const supabase = createClient((process.env.SUPABASE_URL || '').trim(), (process.env.SUPABASE_KEY || '').trim());

// 1. Comando /start ou /ajuda
bot.start((ctx) => {
  ctx.reply('👋 Olá! Mande qualquer gasto por *texto*, *áudio* ou *foto de recibo*.\n\nComandos:\n/resumo - Ver gastos do mês\n/apagar - Apagar o último gasto', { parse_mode: 'Markdown' });
});

// 2. Comando /resumo
bot.command('resumo', async (ctx) => {
  try {
    const { data: gastos, error } = await supabase.from('gastos').select('*').order('id', { ascending: false });
    if (error) throw new Error(error.message);
    if (!gastos || !gastos.length) return ctx.reply('📭 Nenhum gasto registrado ainda.');

    let totalGeral = 0;
    const porCategoria = {};
    gastos.forEach(g => {
      const val = Number(g.valor) || 0;
      totalGeral += val;
      porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + val;
    });

    let msg = `📊 *RESUMO DE GASTOS*\n💰 *Total Geral:* R$ ${totalGeral.toFixed(2)}\n\n*Por Categoria:*\n`;
    for (const [cat, val] of Object.entries(porCategoria)) {
      msg += `• ${cat}: R$ ${val.toFixed(2)}\n`;
    }

    msg += `\n🧾 *Últimos 5 lançamentos:*\n`;
    gastos.slice(0, 5).forEach(g => {
      msg += `[ID ${g.id}] ${g.data} - ${g.estabelecimento}: R$ ${Number(g.valor).toFixed(2)} (${g.pagamento})\n`;
    });

    ctx.reply(msg, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('❌ Erro ao buscar resumo: ' + e.message);
  }
});

// 3. Comando /apagar
bot.command('apagar', async (ctx) => {
  try {
    const partes = ctx.message.text.split(' ');
    const idAlvo = partes[1];
    if (idAlvo) {
      await supabase.from('gastos').delete().eq('id', Number(idAlvo));
      return ctx.reply(`🗑️ Gasto ID ${idAlvo} removido!`);
    }
    const { data } = await supabase.from('gastos').select('id').order('id', { ascending: false }).limit(1);
    if (data && data.length) {
      await supabase.from('gastos').delete().eq('id', data[0].id);
      return ctx.reply(`🗑️ Último gasto (ID ${data[0].id}) removido!`);
    }
    ctx.reply('📭 Nada para apagar.');
  } catch (e) {
    ctx.reply('❌ Erro ao apagar: ' + e.message);
  }
});

// Função auxiliar para salvar com Gemini
async function processarGasto(ctx, partesConteudo) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
    const prompt = `Extraia os dados deste gasto (texto, áudio ou comprovante/recibo) e retorne APENAS um JSON puro (sem markdown e sem crases) neste formato exato:
    {"data": "DD/MM/AAAA", "estabelecimento": "nome curto", "categoria": "Mercado/Refeição/Transporte/Casa/Lazer/Outros", "valor": 0.00, "pagamento": "Pix/Crédito/Débito/Dinheiro"}
    Use ponto nos centavos (ex: 35.90). Data de hoje se não informada: ${new Date().toLocaleDateString('pt-BR')}.`;

    const result = await model.generateContent([prompt, ...partesConteudo]);
    const limpo = result.response.text().replace(/```json|```/g, '').trim();
    const dados = JSON.parse(limpo);

    const { data: inserido, error } = await supabase.from('gastos').insert([dados]).select();
    if (error) throw new Error(error.message);

    const idGerado = (inserido && inserido[0]) ? inserido[0].id : 'OK';
    ctx.reply(`✅ *Salvo [ID ${idGerado}]*\n🏪 *Local:* ${dados.estabelecimento}\n📂 *Cat:* ${dados.categoria}\n💰 *Valor:* R$ ${Number(dados.valor).toFixed(2)}\n💳 *Pag:* ${dados.pagamento}`, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply('❌ Erro: ' + e.message);
  }
}

// 4. Receber Texto normal (ex: "mercado 50 pix")
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await processarGasto(ctx, [ctx.message.text]);
});

// 5. Receber Foto de Recibo/Comprovante
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileUrl.href);
  const buffer = Buffer.from(await res.arrayBuffer());
  const legenda = ctx.message.caption || '';
  await processarGasto(ctx, [legenda, { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } }]);
});

// 6. Receber Áudio de Voz falando o gasto
bot.on('voice', async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileUrl.href);
  const buffer = Buffer.from(await res.arrayBuffer());
  await processarGasto(ctx, [{ inlineData: { data: buffer.toString('base64'), mimeType: 'audio/ogg' } }]);
});

bot.launch();
