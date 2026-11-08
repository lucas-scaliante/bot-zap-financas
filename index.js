// Função auxiliar com leitura instantânea para texto e timeout contra travamento
async function processarGasto(ctx, partesConteudo) {
  const msgEspera = await ctx.reply('⏳ Lendo gasto...');
  
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

    // 1. ATALHO INSTANTÂNEO (0.1s): Se for texto simples (ex: "chiclete 3,00 credito"), nem espera a IA!
    if (partesConteudo.length === 1 && typeof partesConteudo[0] === 'string') {
      const txt = partesConteudo[0].replace('Texto do usuário:', '').trim();
      const matchValor = txt.match(/(\d+[.,]?\d*)/);
      
      if (matchValor) {
        const valorNum = Number(matchValor[1].replace(',', '.'));
        const txtLower = txt.toLowerCase();
        
        let pagamento = 'Outros';
        if (/pix/.test(txtLower)) pagamento = 'Pix';
        else if (/cr[eé]dito|cartao|cartão/.test(txtLower)) pagamento = 'Crédito';
        else if (/d[eé]bito/.test(txtLower)) pagamento = 'Débito';
        else if (/dinheiro|esp[eé]cie/.test(txtLower)) pagamento = 'Dinheiro';

        let estabelecimento = txt
          .replace(matchValor[0], '')
          .replace(/\b(no|na|em|de|do|da|reais|r\$|pix|cr[eé]dito|d[eé]bito|dinheiro|cart[aã]o)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!estabelecimento) estabelecimento = 'Gasto Geral';
        estabelecimento = estabelecimento.charAt(0).toUpperCase() + estabelecimento.slice(1);

        let categoria = 'Outros';
        if (/mercado|atacad|compras|açougue|acougue|hortifruti/.test(txtLower)) categoria = 'Mercado';
        else if (/padaria|lanche|restaurante|ifood|almo[çc]o|janta|chiclete|doce|caf[eé]|pizza|burger|bar/.test(txtLower)) categoria = 'Refeição';
        else if (/uber|99|gasolina|combust[ií]vel|estacionamento|ped[aá]gio|onibus/.test(txtLower)) categoria = 'Transporte';
        else if (/luz|água|agua|internet|aluguel|condom[ií]nio|casa|farm[aá]cia|rem[eé]dio/.test(txtLower)) categoria = 'Casa';
        else if (/cinema|jogo|festa|passeio|streaming|assinatura|lazer/.test(txtLower)) categoria = 'Lazer';

        dados = { data: dataHoje, estabelecimento, categoria, valor: valorNum, pagamento };
      }
    }

    // 2. SE FOR FOTO DE RECIBO OU ÁUDIO: Usa o Gemini com Timeout de 12 segundos por tentativa
    if (!dados) {
      const prompt = `Extraia os dados deste gasto e retorne APENAS um JSON puro neste formato exato:
      {"data": "DD/MM/AAAA", "estabelecimento": "nome curto", "categoria": "Mercado/Refeição/Transporte/Casa/Lazer/Outros", "valor": 0.00, "pagamento": "Pix/Crédito/Débito/Dinheiro"}
      Use ponto nos centavos (ex: 35.90). Data de hoje: ${dataHoje}.`;

      const modelos = ['gemini-3.8-flash-lite', 'gemini-3.8-flash'];
      let result = null;
      let ultimoErro = null;

      for (const nomeModelo of modelos) {
        try {
          const model = genAI.getGenerativeModel({ model: nomeModelo });
          const promessaIA = model.generateContent([prompt, ...partesConteudo]);
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo limite da IA excedido (12s)')), 12000));
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
    await responderFinal(
      `✅ Salvo [ID ${idGerado}]\n🏪 Local: ${dados.estabelecimento}\n📂 Cat: ${dados.categoria}\n💰 Valor: R$ ${Number(dados.valor).toFixed(2)}\n💳 Pag: ${dados.pagamento}`
    );
  } catch (e) {
    await responderFinal('❌ Erro: ' + e.message);
  }
}
