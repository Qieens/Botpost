const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const readline = require('readline');

// Fungsi input multi-line
function inputMultiline(promptText) {
    return new Promise((resolve) => {
        console.log(promptText + '\n(Ketik/paste teks lalu tekan CTRL+D jika selesai)\n');
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => resolve(input.trim()));
    });
}

// Fungsi input satu baris
function inputTerminal(promptText) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(promptText, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

// Parse durasi (misal 5m, 30s, 1h)
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

// Delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Variasi teks anti-spam
function variateText(teksDasar) {
    const emojis = ['✨', '🔥', '💬', '✅', '📌', '🧠', '🚀', '🎯'];
    const zwsp = '\u200B'; // zero-width space
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

// Mulai bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 Scan QR berikut untuk login:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('\n✅ Terhubung ke WhatsApp!\n');

            const teksDasar = await inputMultiline('📨 Masukkan teks yang ingin dikirim (multi-line didukung)');
            const intervalInput = await inputTerminal('⏱️ Masukkan interval kirim pesan (misal: 30s, 5m, 1h):\n> ');
            const intervalMs = parseInterval(intervalInput);

            if (!intervalMs) {
                console.log('❌ Format interval salah. Gunakan contoh: 30s, 5m, 1h');
                process.exit(0);
            }

            const allGroups = await sock.groupFetchAllParticipating();
            const groupIds = Object.keys(allGroups);

            if (groupIds.length === 0) {
                console.log('⚠️ Bot tidak tergabung di grup manapun.');
                process.exit(0);
            }

            console.log(`\n📡 Siap mengirim ke ${groupIds.length} grup setiap ${intervalInput}...\n`);

            const kirimPesanKeSemuaGrup = async () => {
                console.log(`\n🚀 Kirim pesan @ ${new Date().toLocaleTimeString()}`);
                for (const groupId of groupIds) {
                    const namaGrup = allGroups[groupId].subject;
                    const teksFinal = variateText(teksDasar);
                    await sock.sendMessage(groupId, { text: teksFinal });
                    console.log(`✅ [${namaGrup}] → ${teksFinal}`);
                    await delay(Math.random() * 3000 + 2000); // jeda antar grup
                }
            };

            // Kirim pertama kali
            await kirimPesanKeSemuaGrup();

            // Kirim ulang sesuai interval
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
