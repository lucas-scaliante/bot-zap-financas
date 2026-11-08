const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let qrCodeAtual = null;

app.get('/', async (req, res) => {
  if (!qrCodeAtual) return res.send('<h2>✅ Bot conectado e funcionando! (Ou gerando QR Code, atualize em 5s)</h2>');
  const qrImage = await QRCode.toDataURL(qrCodeAtual);
  res.send(`<h2>Escaneie com o WhatsApp do seu iPhone:</h2><img src="${qrImage}" style="width:300px;"/>`);
});
app.listen(process.env.PORT || 3000);

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('sessao_wa');
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    if (qr) qrCodeAtual = qr;
    if (connection === 'open') qrCodeAtual = null;
    if (connection === 'close') setTimeout(iniciarBot, 5000);
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || !msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();
    const temImagem = !!msg.message.imageMessage;

    if (!texto.startsWith('#')) return;
    const comando = texto.toLowerCase();

    // 1. COMANDO #RESUMO (Lista todos os gastos e soma por categoria no WhatsApp)
    if (comando === '#resumo') {
      const { data: gastos, error } = await supabase.from('gastos').select('*').order('id', { ascending: false });
      if (error || !gastos.length) {
        return sock.sendMessage(jid, { text: '📭 Nenhum gasto registrado ainda.' });
      }

      let totalGeral = 0;
      const porCategoria = {};
      gastos.forEach(g => {
        const val = Number(g.valor) || 0;
        totalGeral += val;
        porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + val;
      });

      let resposta = `📊 *RESUMO DE GASTOS*\n💰 *Total Geral:* R$ ${totalGeral.toFixed(2)}\n\n*Por Categoria:*\n`;
      for (const [cat, val] of Object.entries(porCategoria)) {
        resposta += `• ${cat}: R$ ${val.toFixed(2)}\n`;
      }

      resposta += `\n🧾 *Últimos 5 lançamentos:*\n`;
      gastos.slice(0, 5).forEach(g => {
        resposta += `[ID ${g.id}] ${g.data} - ${g.estabelecimento}: R$ ${Number(g.valor).toFixed(2)} (${g.pagamento})\n`;
      });

      return sock.sendMessage(jid, { text: resposta });
    }

    // 2. COMANDO #APAGAR (Apaga o último gasto ou um ID específico)
    if (comando.startsWith('#apagar')) {
      const partes = comando.split(' ');
      if (partes[1]) {
        await supabase.from('gastos').delete().eq('id', Number(partes[1]));
        return sock.sendMessage(jid, { text: `🗑️ Gasto ID ${partes[1]} removido!` });
      } else {
        const { data } = await supabase.from('gastos').select('id').order('id', { ascending: false }).limit(1);
        if (data && data.length) {
          await supabase.from('gastos').delete().eq('id', data[0].id);
          return sock.sendMessage(jid, { text: `🗑️ Último gasto (ID ${data[0].id}) removido!` });
        }
      }
      return;
    }

    // 3. REGISTRAR NOVO GASTO (Texto ou Foto de Recibo)
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = `Extraia os dados deste gasto ou comprovante/nota fiscal e retorne APENAS um JSON puro (sem markdown e sem crases) neste formato:
      {"data": "DD/MM/AAAA", "estabelecimento": "nome curto", "categoria": "Mercado/Refeição/Transporte/Casa/Lazer/Outros", "valor": 0.00, "pagamento": "Pix/Crédito/Débito/Dinheiro"}
      Data de hoje caso não informada: ${new Date().toLocaleDateString('pt-BR')}. Texto: ${texto}`;

      let result;
      if (temImagem) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        result = await model.generateContent([
          prompt,
          { inlineData: { data: buffer.toString('base64'), mimeType: 'image/jpeg' } }
        ]);
      } else {
        result = await model.generateContent(prompt);
      }

      const limpo = result.response.text().replace(/```json|```/g, '').trim();
      const dados = JSON.parse(limpo);

      const { data: inserido } = await supabase.from('gastos').insert([dados]).select();
      const idGerado = inserido ? inserido[0].id : '?';

      await sock.sendMessage(jid, {
        text: `✅ *Salvo [ID ${idGerado}]*\n🏪 *Local:* ${dados.estabelecimento}\n📂 *Cat:* ${dados.categoria}\n💰 *Valor:* R$ ${Number(dados.valor).toFixed(2)}\n💳 *Pag:* ${dados.pagamento}`
      });
    } catch (e) {
      await sock.sendMessage(jid, { text: '❌ Erro ao ler o gasto. Tente novamente.' });
    }
  });
}

iniciarBot();
