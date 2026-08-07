import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

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

// 1. ROTA DE CONFIGURAÇÕES PÚBLICAS (substitui config.php)
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

// 2. ROTA PARA GERAR PIX (substitui gerar_pix.php)
app.post('/api/gerar-pix', async (req, res) => {
    try {
        const dadosEntrada = req.body || {};
        const url_api = process.env.PAYSHARK_API_URL || 'https://api.paysharkgateway.com.br';
        const api_key = process.env.PAYSHARK_API_KEY || '';
        const api_secret = process.env.PAYSHARK_API_SECRET || '';

        let valor = 10.00;
        if (dadosEntrada.valor) {
            valor = parseFloat(String(dadosEntrada.valor).replace(',', '.'));
        }

        const nomeCliente = process.env.PIX_GATEWAY_CLIENT_NAME || 'Cliente Pedágio Digital';
        const cpfGenerico = process.env.PIX_GATEWAY_CLIENT_DOCUMENT || '00000000000';
        const telefonePadrao = process.env.PIX_GATEWAY_CLIENT_PHONE || '11999999999';
        const emailPadrao = process.env.PIX_GATEWAY_CLIENT_EMAIL || 'pagamento@pedagiodigital.com';
        const postbackUrl = process.env.PIX_GATEWAY_CALLBACK_URL || '';

        const payload = {
            amount: valor,
            description: `Pagamento Pedágio - ${dadosEntrada.placa || 'Consulta'}`,
            customer: {
                name: nomeCliente,
                email: emailPadrao,
                phone: telefonePadrao,
                document: {
                    number: cpfGenerico,
                    type: 'cpf'
                }
            },
            items: [
                {
                    title: 'Regularização de Débito',
                    unitPrice: valor,
                    quantity: 1
                }
            ],
            postbackUrl: postbackUrl
        };

        const response = await fetch(`${url_api.replace(/\/$/, '')}/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': api_key,
                'X-API-Secret': api_secret
            },
            body: JSON.stringify(payload)
        });

        const resData = await response.json();

        if (resData.paymentData && resData.paymentData.copiaecola) {
            return res.json({
                status: "true",
                copy_paste: resData.paymentData.copiaecola,
                qr_code_url: resData.paymentData.qrcode
            });
        } else {
            return res.json({
                status: "false",
                error: "Falha na API: " + (resData.message || 'Erro desconhecido'),
                details: resData
            });
        }
    } catch (error) {
        console.error('Erro ao gerar Pix:', error);
        return res.status(500).json({ status: "false", error: "Erro interno no servidor ao gerar Pix" });
    }
});

// 3. ROTA DE WEBHOOK (substitui webhook.php)
app.post('/api/webhook', async (req, res) => {
    try {
        const dados = req.body;
        console.log('LOG WEBHOOK:', JSON.stringify(dados));

        if (!dados) {
            return res.status(400).send("Payload inválido");
        }

        const status = dados.status ? String(dados.status).trim().toUpperCase() : '';

        if (status === 'COMPLETED' || status === 'PAGO') {
            let descricao = dados.description || '';
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
                return res.status(200).send(`Firebase atualizado com sucesso para a placa: ${chaveLimpa}`);
            } else {
                console.error(`Erro ao extrair placa da descrição: '${descricao}'`);
            }
        }

        return res.status(200).send("Webhook recebido, mas nenhum status de conclusão detectado.");
    } catch (err) {
        console.error('Erro no processamento do Webhook:', err);
        return res.status(500).send("Erro interno no servidor do webhook");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});