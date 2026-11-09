const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // Variável automática do próprio Render

const bot = new Telegraf((process.env.TELEGRAM_TOKEN || '').trim());
const genAI = new GoogleGenerativeAI((process.env.GEMINI_API_KEY || '').trim());
const supabase = createClient((process.env.SUPABASE_URL || '').trim(), (process.env.SUPABASE_KEY || '').trim());

app.get('/', (req, res) => res.send('✅ Bot Financeiro ativo e acordado!'));

// 1. Comando /start
bot.start((ctx) => {
  ctx.reply(
    '👋 Olá! Veja como registrar:\n\n' +
    '🔴 Para GASTOS: "mercado 50 pix" ou mande foto/áudio\n' +
    '🟢 Para LUCROS: "+ 150 aula pix" ou "lucro 200 venda"\n\n' +
    'Comandos:\n/resumo - Ver balanço (Lucros, Gastos e Saldo)\n/apagar - Apagar o último registro'
  );
});

// 2. Comando /resumo (Calcula Lucros, Gastos e Saldo Líquido)
bot.command('resumo', async (ctx) => {
  try {
    const { data: registros, error } = await supabase.from('gastos').select('*').order('id', { ascending: false });
    if (error) throw new Error(error.message);
    if (!registros || !registros.length) return ctx.reply('📭 Nenhum registro salvo ainda.');

    let totalGastos = 0;
    let totalLucros = 0;
    const porCategoria = {};

    registros.forEach(r => {
      const val = Number(r.valor) || 0;
      if (r.categoria === 'Lucro') {
        totalLucros += val;
      } else {
        totalGastos += val;
        porCategoria[r.categoria] = (porCategoria[r.categoria] || 0) + val;
      }
    });

    const saldo = totalLucros - totalGastos;

    let msg = `📊 BALANÇO FINANCEIRO\n`;
    msg += `🟢 Total de Lucros: R$ ${totalLucros.toFixed(2)}\n`;
    msg += `🔴 Total de Gastos: R$ ${totalGastos.toFixed(2)}\n`;
    msg += `💰 Saldo Líquido: R$ ${saldo.toFixed(2)}\n`;

    if (Object.keys(porCategoria).length > 0) {
      msg += `\n📂 Gastos por Categoria:\n`;
      for (const [cat, val] of Object.entries(porCategoria)) {
        msg += `• ${cat}: R$ ${val.toFixed(2)}\n`;
      }
    }

    msg += `\n🧾 Últimos 5 lançamentos:\n`;
    registros.slice(0, 5).forEach(r => {
      const icone = r.categoria === 'Lucro' ? '🟢 +' : '🔴 -';
      msg += `[ID ${r.id}] ${icone}R$ ${Number(r.valor).toFixed(2)} - ${r.estabelecimento} (${r.data})\n`;
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
      return ctx.reply(`🗑️ Registro ID ${idAlvo} removido!`);
    }
    const { data } = await supabase.from('gastos').select('id').order('id', { ascending: false }).limit(1);
    if (data && data.length) {
      await supabase.from('gastos').delete().eq('id', data[0].id);
      return ctx.reply(`🗑️ Último registro (ID ${data[0].id}) removido!`);
    }
    await ctx.reply('📭 Nada para apagar.');
  } catch (e) {
    await ctx.reply('❌ Erro ao apagar: ' + e.message);
  }
});

// Função principal para processar Gastos e Lucros
async function processarGasto(ctx, partesConteudo) {
  const msgEspera = await ctx.reply('⏳ Processando...');

  const responderFinal = async (textoFinal) => {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, msgEspera.message_id, null, textoFinal);
    } catch (_) {
      await ctx.reply(textoFinal);
    }
  };

  try {
    let dados = null;
    const dataHoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // 1. ATALHO INSTANTÂNEO PARA TEXTO (Gastos e Lucros)
    if (partesConteudo.length === 1 && typeof partesConteudo[0] === 'string') {
      const txt = partesConteudo[0].replace('Texto do usuário:', '').trim();
      const matchValor = txt.match(/(\d+[.,]?\d*)/);

      if (matchValor) {
        const valorNum = Number(matchValor[1].replace(',', '.'));
        const txtLower = txt.toLowerCase();

        // Detecta se é Lucro/Entrada
        const ehLucro = txt.startsWith('+') || /\b(lucro|recebi|ganhei|entrada|venda|vendi|sal[aá]rio|renda)\b/i.test(txtLower);

        let pagamento = 'Outros';
        if (/pix/.test(txtLower)) pagamento = 'Pix';
        else if (/cr[eé]dito|cartao|cartão/.test(txtLower)) pagamento = 'Crédito';
        else if (/d[eé]bito/.test(txtLower)) pagamento = 'Débito';
        else if (/dinheiro|esp[eé]cie/.test(txtLower)) pagamento = 'Dinheiro';

        let estabelecimento = txt
          .replace(matchValor[0], '')
          .replace(/^\+/, '')
          .replace(/\b(no|na|em|de|do|da|reais|r\$|pix|cr[eé]dito|d[eé]bito|dinheiro|cart[aã]o|lucro|recebi|ganhei|entrada)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!estabelecimento) estabelecimento = ehLucro ? 'Entrada' : 'Gasto Geral';
        estabelecimento = estabelecimento.charAt(0).toUpperCase() + estabelecimento.slice(1);

        let categoria = 'Outros';
        if (ehLucro) {
          categoria = 'Lucro';
        } else if (/mercado|atacad|compras|açougue|acougue|hortifruti/.test(txtLower)) {
          categoria = 'Mercado';
        } else if (/padaria|lanche|restaurante|ifood|almo[çc]o|janta|chiclete|doce|caf[eé]|pizza|burger|bar/.test(txtLower)) {
          categoria = 'Refeição';
        } else if (/uber|99|gasolina|combust[ií]vel|estacionamento|ped[aá]gio|onibus/.test(txtLower)) {
          categoria = 'Transporte';
        } else if (/luz|água|agua|internet|aluguel|condom[ií]nio|casa|farm[aá]cia|rem[eé]dio/.test(txtLower)) {
          categoria = 'Casa';
        } else if (/cinema|jogo|festa|passeio|streaming|assinatura|lazer/.test(txtLower)) {
          categoria = 'Lazer';
        }

        dados = { data: dataHoje, estabelecimento, categoria, valor: valorNum, pagamento };
      }
    }

    // 2. SE FOR FOTO OU ÁUDIO: Usa o Gemini
    if (!dados) {
      const prompt = `Extraia os dados deste lançamento financeiro (gasto ou lucro/receita) e retorne APENAS um JSON puro neste formato exato:
      {"data": "DD/MM/AAAA", "estabelecimento": "nome curto", "categoria": "Lucro/Mercado/Refeição/Transporte/Casa/Lazer/Outros", "valor": 0.00, "pagamento": "Pix/Crédito/Débito/Dinheiro"}
      Se for um ganho, recebimento ou lucro, use obrigatoriamente a categoria "Lucro". Use ponto nos centavos (ex: 35.90). Data de hoje: ${dataHoje}.`;

      const modelos = ['gemini-3.8-flash-lite', 'gemini-3.8-flash'];
      let result = null;
      let ultimoErro = null;

      for (const nomeModelo of modelos) {
        try {
          const model = genAI.getGenerativeModel({ model: nomeModelo });
          const promessaIA = model.generateContent([prompt, ...partesConteudo]);
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo limite excedido (12s)')), 12000));
          result = await Promise.race([promessaIA, timeout]);
          if (result) break;
        } catch (err) {
          ultimoErro = err;
        }
      }

      if (!result) throw ultimoErro;

      const textoBruto = result.response.text();
      const matchJSON = textoBruto.match(/\{[\s\S]*\}/);
      if (!matchJSON) throw new Error('Formato inválido retornado pela IA.');
      dados = JSON.parse(matchJSON[0]);
    }

    // 3. SALVA NO SUPABASE
    const { data: inserido, error } = await supabase.from('gastos').insert([{
      data: String(dados.data || dataHoje),
      estabelecimento: String(dados.estabelecimento || 'Outros'),
      categoria: String(dados.categoria || 'Outros'),
      valor: Number(String(dados.valor).replace(',', '.')) || 0,
      pagamento: String(dados.pagamento || 'Outros')
    }]).select();

    if (error) throw new Error('Banco de dados: ' + error.message);

    const idGerado = (inserido && inserido[0]) ? inserido[0].id : 'OK';
    const ehLucroSalvo = dados.categoria === 'Lucro';
    const titulo = ehLucroSalvo ? `🟢 Lucro Salvo [ID ${idGerado}]` : `🔴 Gasto Salvo [ID ${idGerado}]`;

    await responderFinal(
      `${titulo}\n📌 Descrição: ${dados.estabelecimento}\n📂 Cat: ${dados.categoria}\n💰 Valor: R$ ${Number(dados.valor).toFixed(2)}\n💳 Meio: ${dados.pagamento}`
    );
  } catch (e) {
    await responderFinal('❌ Erro: ' + e.message);
  }
}

// 4. Receber Texto, Foto e Áudio
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await processarGasto(ctx, ['Texto do usuário: ' + ctx.message.text]);
});

bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileUrl.href);
  const buffer = Buffer.from(await res.arrayBuffer());
  const legenda = ctx.message.caption || '';
  await processarGasto(ctx, [legenda, { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } }]);
});

bot.on('voice', async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileUrl.href);
  const buffer = Buffer.from(await res.arrayBuffer());
  await processarGasto(ctx, [{ inlineData: { data: buffer.toString('base64'), mimeType: 'audio/ogg' } }]);
});

// 5. Inicialização Automática (Webhook + Auto-Ping para não hibernar)
if (RENDER_URL) {
  const caminhoWebhook = '/webhook-telegram';
  app.use(bot.webhookCallback(caminhoWebhook));
  app.listen(PORT, async () => {
    await bot.telegram.setWebhook(`${RENDER_URL}${caminhoWebhook}`);
    console.log('Webhook configurado com sucesso em:', RENDER_URL);
  });

  // Auto-ping a cada 10 minutos para manter o Render acordado sozinho
  setInterval(() => {
    fetch(RENDER_URL).catch(() => {});
  }, 10 * 60 * 1000);
} else {
  app.listen(PORT);
  bot.launch({ dropPendingUpdates: true });
}
