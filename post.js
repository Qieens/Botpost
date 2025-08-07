process.env.BAILEYS_NO_LOG = 'true';

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const OWNER_NUMBER = '628975539822@s.whatsapp.net'; // Ganti dengan nomor kamu (pakai @s.whatsapp.net)

let currentText = '';
let currentIntervalMs = 5 * 60 * 1000;
let broadcastActive = false;
let broadcastInterval;

function parseInterval(text) {
    const match = text.match(/^(\d+)(s|m|h)$/i);
    if (!match) return null;
    const [, value, unit] = match;
    const num = parseInt(value);
    switch (unit.toLowerCase()) {
        case 's': return num * 1000;
        case 'm': return num * 60 * 1000;
        case 'h': return num * 60 * 60 * 1000;
        default: return null;
    }
}

function humanInterval(ms) {
    if (ms < 60000) return `${ms / 1000}s`;
    if (ms < 3600000) return `${ms / 60000}m`;
    return `${ms / 3600000}h`;
}

function variateText(base) {
    const emojis = ['✨', '🔥', '✅', '📌', '🧠', '🚀', '🎯'];
    const zwsp = '\u200B';
    const randEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    const rand = Math.floor(Math.random() * 4);
    switch (rand) {
        case 0: return base + " " + randEmoji;
        case 1: return base.replace(/,/g, `${randEmoji},`);
        case 2: return base.replace(/\s/g, m => m + (Math.random() > 0.7 ? zwsp : ""));
        case 3: return base.slice(0, 5) + randEmoji + base.slice(5);
        default: return base;
    }
}

function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function kirimBroadcast(sock) {
    if (!currentText || !currentIntervalMs) return;

    const groupsData = await sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groupsData);

    let success = 0;
    let failed = 0;
    let locked = [];

    for (const gid of groupIds) {
        const info = groupsData[gid];
        if (info.announce) {
            locked.push(`🔒 ${info.subject}`);
            continue;
        }

        try {
            await sock.sendMessage(gid, { text: variateText(currentText) });
            success++;
        } catch (err) {
            failed++;
        }

        await delay(Math.random() * 3000 + 1500);
    }

    let report = `📢 Laporan Broadcast:\n\n✅ Terkirim: ${success}\n❌ Gagal: ${failed}\n🔒 Grup Terkunci: ${locked.length}`;
    if (locked.length > 0) {
        report += `\n\n${locked.join('\n')}`;
    }

    try {
        await sock.sendMessage(OWNER_NUMBER, { text: report });
    } catch (err) {
        console.log('❌ Gagal kirim laporan ke owner:', err.message);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log('✅ Bot aktif dan siap menerima perintah WA Owner');
            await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah dari owner.' });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            console.log('❌ Terputus. Reconnect:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                process.exit(1);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid !== OWNER_NUMBER) return;

        const teks = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (teks.startsWith('.settext ')) {
            currentText = teks.slice(9).trim();
            await sock.sendMessage(OWNER_NUMBER, { text: '✅ Pesan broadcast disimpan.' });
        } else if (teks.startsWith('.setinterval ')) {
            const parsed = parseInterval(teks.slice(13).trim());
            if (!parsed) {
                await sock.sendMessage(OWNER_NUMBER, { text: '❌ Format salah. Contoh: .setinterval 5m' });
            } else {
                currentIntervalMs = parsed;
                await sock.sendMessage(OWNER_NUMBER, { text: `✅ Interval diatur: ${teks.slice(13).trim()}` });
            }
        } else if (teks === '.start') {
            if (!currentText) {
                return await sock.sendMessage(OWNER_NUMBER, { text: '❌ Gunakan `.settext` terlebih dahulu.' });
            }
            if (broadcastActive) {
                return await sock.sendMessage(OWNER_NUMBER, { text: '❌ Broadcast sudah berjalan.' });
            }
            broadcastActive = true;
            await sock.sendMessage(OWNER_NUMBER, { text: `🚀 Broadcast dimulai. Interval: ${humanInterval(currentIntervalMs)}` });
            await kirimBroadcast(sock);
            broadcastInterval = setInterval(() => kirimBroadcast(sock), currentIntervalMs);
        } else if (teks === '.stop') {
            if (!broadcastActive) {
                return await sock.sendMessage(OWNER_NUMBER, { text: '❌ Broadcast belum berjalan.' });
            }
            clearInterval(broadcastInterval);
            broadcastActive = false;
            await sock.sendMessage(OWNER_NUMBER, { text: '🛑 Broadcast dihentikan.' });
        } else if (teks === '.status') {
            let statusMsg = `📊 Status Broadcast:\n\n`;
            statusMsg += `📍 Aktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\n`;
            statusMsg += `🕒 Interval: ${humanInterval(currentIntervalMs)}\n`;
            statusMsg += `📄 Isi Pesan:\n${currentText ? currentText : '⚠️ Belum diset!'}`;
            await sock.sendMessage(OWNER_NUMBER, { text: statusMsg });
        }
    });
}

startBot();