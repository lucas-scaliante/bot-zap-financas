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

// 1. Comando /start
bot.start((ctx) => {
  ctx.reply('👋 Olá! Mande qualquer gasto por texto, áudio ou foto de recibo.\n\nComandos:\n/resumo - Ver gastos do mês\n/apagar - Apagar o último gasto');
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

    let msg = `📊 RESUMO DE GASTOS\n💰 Total Geral: R$ ${totalGeral.toFixed(2)}\n\nPor Categoria:\n`;
    for (const [cat, val] of Object.entries(porCategoria)) {
      msg += `• ${cat}: R$ ${val.toFixed(2)}\n`;
    }

    msg += `\n🧾 Últimos 5 lançamentos:\n`;
    gastos.slice(0, 5).forEach(g => {
      msg += `[ID ${g.id}] ${g.data} - ${g.estabelecimento}: R$ ${Number(g.valor).toFixed(2)} (${g.pagamento})\n`;
    });

    await ctx.reply(msg);
  } catch (e) {
    await ctx.reply('❌ Erro ao buscar resumo: ' + e.message);
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
    await ctx.reply('📭 Nada para apagar.');
  } catch (e) {
    await ctx.reply('❌ Erro ao apagar: ' + e.message);
  }
});

// Função auxiliar para processar e salvar no Supabase
async function processarGasto(ctx, partesConteudo) {
  const msgEspera = await ctx.reply('⏳ Lendo gasto...');
  try {
    const prompt = `Extraia os dados deste gasto (texto, áudio ou comprovante/recibo) e retorne APENAS um JSON puro neste formato exato:
    {"data": "DD/MM/AAAA", "estabelecimento": "nome curto", "categoria": "Mercado/Refeição/Transporte/Casa/Lazer/Outros", "valor": 0.00, "pagamento": "Pix/Crédito/Débito/Dinheiro"}
    Use ponto nos centavos (ex: 35.90). Data de hoje se não informada: ${new Date().toLocaleDateString('pt-BR')}.`;

    const modelos = ['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-2.0-flash'];
    let result = null;
    let ultimoErro = null;

    for (const nomeModelo of modelos) {
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
          const model = genAI.getGenerativeModel({ model: nomeModelo });
          result = await model.generateContent([prompt, ...partesConteudo]);
          break;
        } catch (err) {
          ultimoErro = err;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (result) break;
    }

    if (!result) throw ultimoErro;

    const textoBruto = result.response.text();
    const matchJSON = textoBruto.match(/\{[\s\S]*\}/);
    if (!matchJSON) throw new Error('A IA não retornou um JSON válido: ' + textoBruto);
    const dados = JSON.parse(matchJSON[0]);

    const { data: inserido, error } = await supabase.from('gastos').insert([{
      data: String(dados.data || ''),
      estabelecimento: String(dados.estabelecimento || 'Outros'),
      categoria: String(dados.categoria || 'Outros'),
      valor: Number(String(dados.valor).replace(',', '.')) || 0,
      pagamento: String(dados.pagamento || 'Outros')
    }]).select();

    if (error) throw new Error('Banco de dados: ' + error.message);

    const idGerado = (inserido && inserido[0]) ? inserido[0].id : 'OK';
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msgEspera.message_id,
      null,
      `✅ Salvo [ID ${idGerado}]\n🏪 Local: ${dados.estabelecimento}\n📂 Cat: ${dados.categoria}\n💰 Valor: R$ ${Number(dados.valor).toFixed(2)}\n💳 Pag: ${dados.pagamento}`
    );
  } catch (e) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msgEspera.message_id,
      null,
      '❌ Erro: ' + e.message
    );
  }
}

// 4. Receber Texto normal
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await processarGasto(ctx, ['Texto do usuário: ' + ctx.message.text]);
});

// 5. Receber Foto de Recibo
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileUrl.href);
  const buffer = Buffer.from(await res.arrayBuffer());
  const legenda = ctx.message.caption || '';
  await processarGasto(ctx, [legenda, { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } }]);
});

// 6. Receber Áudio de Voz
bot.on('voice', async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileUrl.href);
  const buffer = Buffer.from(await res.arrayBuffer());
  await processarGasto(ctx, [{ inlineData: { data: buffer.toString('base64'), mimeType: 'audio/ogg' } }]);
});

bot.launch({ dropPendingUpdates: true });
