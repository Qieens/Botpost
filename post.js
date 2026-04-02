import makeWASocket from "@whiskeysockets/baileys";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import readline from "readline";

// Input nomor
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Fungsi input
const ask = (q) => new Promise(resolve => rl.question(q, resolve));


// ============================
//  FUNGSI LOGIN KODE PAIRING
// ============================
const loginWithCode = async (number) => {
    console.log("🔌 Menghubungkan ke WhatsApp...");

    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "22.0"],
        syncFullHistory: false,
    });

    // Tunggu koneksi siap
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject("❌ Timeout menunggu koneksi WhatsApp"), 20000);

        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "connecting") {
                console.log("⏳ Menghubungkan...");
            }

            if (connection === "open") {
                clearTimeout(timeout);
                console.log("✅ Koneksi WhatsApp siap.");
                resolve();
            }

            if (connection === "close") {
                reject(lastDisconnect?.error || "❌ Koneksi terputus!");
            }
        });
    });

    console.log("🔑 Meminta kode pairing...");
    const code = await sock.requestPairingCode(number);

    console.log(`\n📟 *Kode Pairing*: ${code}\n`);

    sock.ev.on("creds.update", saveCreds);

    return sock;
};


// ============================
//  START BOT
// ============================
const start = async () => {
    const number = await ask("📱 Masukkan nomor (format 628xxxx): ");
    rl.close();

    try {
        await loginWithCode(number);
    } catch (e) {
        console.error("\n❌ ERROR:", e);
    }
};

start();