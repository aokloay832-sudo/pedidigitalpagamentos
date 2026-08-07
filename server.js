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

// Serve a pasta de arquivos estáticos (HTML, CSS, imagens)
app.use(express.static(path.join(__dirname, 'public')));

// Rota para abrir o Admin se acessar /admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

// 2. ROTA PARA GERAR PIX (PayShark V1 API)
app.post(['/api/gerar-pix', '/gerar-pix', '/api/gerar_pix.php', '/gerar_pix.php'], async (req, res) => {
    try {
        const dadosEntrada = req.body || {};

        // Converter valor de reais para centavos
        let valorReais = 10.00;
        if (dadosEntrada.valor) {
            valorReais = parseFloat(String(dadosEntrada.valor).replace(',', '.'));
        }
        const amountCents = Math.round(valorReais * 100);

        // Credenciais PayShark
        const apiKey = (process.env.PAYSHARK_API_KEY || process.env.PIX_GATEWAY_PUBLIC_KEY || '').trim();
        const apiSecret = (process.env.PAYSHARK_API_SECRET || process.env.PIX_GATEWAY_SECRET_KEY || '').trim();

        if (!apiKey || !apiSecret) {
            return res.status(500).json({ status: false, error: "Credenciais da PayShark não configuradas." });
        }

        const urlBase = (process.env.PAYSHARK_API_URL || 'https://api.paysharkgateway.com.br').replace(/\/$/, '');
        const endpoint = `${urlBase}/v1/transactions`;
        const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;

        // Dados do Cliente
        const doc = String(process.env.PIX_GATEWAY_CLIENT_DOCUMENT || '01387220055').replace(/\D/g, '');
        const phone = String(process.env.PIX_GATEWAY_CLIENT_PHONE || '11999999999').replace(/\D/g, '');
        const email = String(process.env.PIX_GATEWAY_CLIENT_EMAIL || 'teste@teste.com').trim();
        const placa = String(dadosEntrada.placa || '').trim().toUpperCase();
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

        console.log(`[PAYSHARK RESP HTTP ${response.status}]:`, JSON.stringify(resData));

        const tx = resData.data || resData;
        const pixInfo = tx.pix || {};
        const copiaCola = pixInfo.qrcode || pixInfo.qrCode || pixInfo.copyPaste || tx.copy_paste || '';

        if (copiaCola) {
            // Gera a imagem do QR Code em Base64 para o frontend
            let qrcodeBase64 = '';
            try {
                const dataUrl = await QRCode.toDataURL(copiaCola, { margin: 1, width: 280 });
                qrcodeBase64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
            } catch (qrErr) {
                console.error("Erro ao gerar QR Code Base64:", qrErr);
            }

            // Retorno ultra-compatível com qualquer versão do frontend
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
                paymentData: {
                    copiaecola: copiaCola,
                    qrcode: copiaCola,
                    qrcode_base64: qrcodeBase64
                },
                data: {
                    copy_paste: copiaCola,
                    qrcode: copiaCola,
                    qrcode_base64: qrcodeBase64
                }
            });
        } else {
            return res.json({
                status: false,
                error: resData.message || tx.message || 'Falha ao obter QR Code da PayShark'
            });
        }

    } catch (error) {
        console.error('Erro no servidor ao gerar Pix:', error);
        return res.status(500).json({ status: false, error: "Erro interno no servidor: " + error.message });
    }
});

// 3. ROTA DE WEBHOOK
app.post('/api/webhook', async (req, res) => {
    try {
        const dados = req.body;
        console.log('LOG WEBHOOK:', JSON.stringify(dados));

        if (!dados) {
            return res.status(400).send("Payload inválido");
        }

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
                const dbUrl = (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
                const urlFirebase = `${dbUrl}/veiculos/${chaveLimpa}.json`;

                const dataAgora = new Date().toISOString().replace('T', ' ').substring(0, 19);

                const fbResponse = await fetch(urlFirebase, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: "pago",
                        atualizado_em: dataAgora
                    })
                });

                console.log(`Placa: ${chaveLimpa} | HTTP Firebase: ${fbResponse.status}`);
                return res.status(200).send(`Firebase atualizado para a placa: ${chaveLimpa}`);
            }
        }

        return res.status(200).send("Webhook processado.");
    } catch (err) {
        console.error('Erro no Webhook:', err);
        return res.status(500).send("Erro interno no webhook");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor executando na porta ${PORT}`);
});