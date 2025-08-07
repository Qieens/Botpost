process.env.BAILEYS_NO_LOG = 'true'; // ✅ Nonaktifkan log internal Baileys

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const readline = require('readline');
const pino = require('pino'); // ✅ Tambahkan pino logger

// Fungsi input multi-line dari terminal (CTRL+D untuk selesai)
function inputMultiline(promptText) {
    console.log(promptText);
    return new Promise(resolve => {
        let input = '';
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });

        rl.on('line', (line) => {
            input += line + '\n';
        });

        rl.on('close', () => {
            resolve(input.trim());
        });
    });
}

// Parsing waktu dari string seperti "5m", "30s", "1h"
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

// Fungsi delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Variasi teks (anti-spam)
function variateText(teksDasar) {
    const emojis = ['✨', '🔥', '💬', '✅', '📌', '🧠', '🚀', '🎯'];
    const zwsp = '\u200B';
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    const pola = Math.floor(Math.random() * 4);

    switch (pola) {
        case 0:
            return teksDasar + " " + randomEmoji;
        case 1:
            return teksDasar.replace(/,/g, `${randomEmoji},`);
        case 2:
            return teksDasar.replace(/\s/g, match => match + (Math.random() > 0.7 ? zwsp : ""));
        case 3:
            return teksDasar.slice(0, 5) + randomEmoji + teksDasar.slice(5);
        default:
            return teksDasar;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }) // ✅ Gunakan pino dan nonaktifkan log internal
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan QR berikut untuk login:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('\n✅ Terhubung ke WhatsApp!');

            const teksDasar = await inputMultiline('📨 Masukkan teks yang ingin dikirim (multi-line didukung)\n(Ketik/paste teks lalu tekan CTRL+D jika selesai)');
            const intervalInput = await inputMultiline('⏱️ Masukkan interval kirim pesan (misal: 30s, 5m, 1h):');
            const intervalMs = parseInterval(intervalInput);

            if (!intervalMs) {
                console.log('❌ Format interval salah. Gunakan contoh: 30s, 5m, atau 1h');
                process.exit(0);
            }

            const allGroups = await sock.groupFetchAllParticipating();
            const groupIds = Object.keys(allGroups);

            if (groupIds.length === 0) {
                console.log('⚠️ Bot tidak tergabung di grup manapun.');
                process.exit(0);
            }

            console.log(`\n🔍 Ditemukan ${groupIds.length} grup`);
            groupIds.forEach(gid => {
                console.log(`🕵️ Kirim ke: ${gid} (${allGroups[gid].subject})`);
            });

            const kirimPesanKeSemuaGrup = async () => {
                console.log(`\n🚀 Mulai kirim @ ${new Date().toLocaleTimeString()}`);
                for (const groupId of groupIds) {
                    const namaGrup = allGroups[groupId].subject;
                    const teksFinal = variateText(teksDasar);
                    try {
                        await sock.sendMessage(groupId, { text: teksFinal });
                        console.log(`✅ [${namaGrup}] → SUKSES`);
                    } catch (err) {
                        console.log(`❌ [${namaGrup}] → GAGAL: ${err.message}`);
                    }
                    await delay(Math.random() * 3000 + 2000); // 2-5 detik antar grup
                }
            };

            // Pertama kali kirim
            await kirimPesanKeSemuaGrup();

            // Ulangi tiap interval
            setInterval(kirimPesanKeSemuaGrup, intervalMs);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Koneksi terputus. Reconnect:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                process.exit(1);
            }
        }
    });
}

startBot();