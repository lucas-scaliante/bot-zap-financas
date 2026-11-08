const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const genAI = new GoogleGenerativeAI((process.env.GEMINI_API_KEY || '').trim());
const supabase = createClient((process.env.SUPABASE_URL || '').trim(), (process.env.SUPABASE_KEY || '').trim());
let qrCodeAtual = null;
let statusConexao = 'Iniciando...';

app.get('/', async (req, res) => {
  if (qrCodeAtual) {
    const qrImage = await QRCode.toDataURL(qrCodeAtual);
    return res.send(`<h2>Escaneie com o WhatsApp do seu iPhone:</h2><img src="${qrImage}" style="width:300px;"/><p>Status: ${statusConexao}</p>`);
  }
  res.send(`<h2>Status do Bot: ${statusConexao}</h2><p>Atualize a página em 5 segundos se estiver aguardando o QR Code.</p>`);
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
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeAtual = qr;
      statusConexao = 'Aguardando leitura do QR Code';
    }
    if (connection === 'open') {
      qrCodeAtual = null;
      statusConexao = '✅ Conectado e Funcionando!';
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      statusConexao = 'Desconectado. Reconectando...';
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(iniciarBot, 3000);
      } else {
        statusConexao = '❌ Sessão encerrada no celular. Reinicie o serviço no Render para gerar novo QR Code.';
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || !msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();
    const temImagem = !!msg.message.imageMessage;

    if (!texto.startsWith('#')) return;
    const comando = texto.toLowerCase();

    // Ignora as próprias respostas do bot para não criar loop
    if (texto.includes('*Salvo [ID') || texto.includes('*RESUMO DE GASTOS*') || texto.startsWith('❌')) return;

    try {
      // 1. COMANDO #RESUMO
      if (comando === '#resumo') {
        const { data: gastos, error } = await supabase.from('gastos').select('*').order('id', { ascending: false });
        if (error) throw new Error('Supabase: ' + error.message);
        if (!gastos || !gastos.length) {
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

      // 2. COMANDO #APAGAR
      if (comando.startsWith('#apagar')) {
        const partes = comando.split(' ');
        if (partes[1]) {
          const { error } = await supabase.from('gastos').delete().eq('id', Number(partes[1]));
          if (error) throw new Error('Supabase: ' + error.message);
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

      // 3. REGISTRAR NOVO GASTO
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const prompt = `Extraia os dados deste gasto ou comprovante e retorne APENAS um JSON puro (sem markdown e sem crases) neste formato exato:
      {"data": "DD/MM/AAAA", "estabelecimento": "nome curto", "categoria": "Mercado/Refeição/Transporte/Casa/Lazer/Outros", "valor": 0.00, "pagamento": "Pix/Crédito/Débito/Dinheiro"}
      Use ponto para centavos no valor (ex: 25.50). Data de hoje: ${new Date().toLocaleDateString('pt-BR')}. Texto: ${texto}`;

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

      const textoIA = result.response.text().replace(/```json|```/g, '').trim();
      const dados = JSON.parse(textoIA);

      const { data: inserido, error: dbError } = await supabase.from('gastos').insert([dados]).select();
      if (dbError) throw new Error('Erro no Banco: ' + dbError.message);

      const idGerado = (inserido && inserido[0]) ? inserido[0].id : 'OK';

      await sock.sendMessage(jid, {
        text: `✅ *Salvo [ID ${idGerado}]*\n🏪 *Local:* ${dados.estabelecimento}\n📂 *Cat:* ${dados.categoria}\n💰 *Valor:* R$ ${Number(dados.valor).toFixed(2)}\n💳 *Pag:* ${dados.pagamento}`
      });
    } catch (e) {
      await sock.sendMessage(jid, { text: '❌ Motivo do erro: ' + e.message });
    }
  });
}

iniciarBot();
