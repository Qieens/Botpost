// ENV setup
process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')

// ====== KONFIGURASI ======
const OWNER_NUMBER = '628975539822@s.whatsapp.net' // Nomor owner format JID
const CONFIG_PATH = './config.json'

// ====== LOAD / SIMPAN CONFIG ======
let config = { currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false }
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH)) } catch {}
}
let { currentText, currentIntervalMs, broadcastActive } = config
let broadcastInterval
const saveConfig = () => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ currentText, currentIntervalMs, broadcastActive }, null, 2))
  } catch (e) {
    console.log('⚠️ Gagal menyimpan config:', e.message)
  }
}

// Helper untuk membandingkan nomor JID secara robust (bandingkan bagian sebelum @)
const jidBase = (jid) => (typeof jid === 'string' && jid.includes('@')) ? jid.split('@')[0] : jid

// ====== FUNGSI UTIL ======
const parseInterval = (text) => {
  const match = text.match(/^(\d+)(s|m|h)$/i)
  if (!match) return null
  const [, val, unit] = match
  const num = parseInt(val)
  return unit.toLowerCase() === 's' ? num * 1000 : unit.toLowerCase() === 'm' ? num * 60000 : num * 3600000
}

const humanInterval = (ms) => {
  if (ms < 60000) return `${ms / 1000}s`
  if (ms < 3600000) return `${ms / 60000}m`
  return `${ms / 3600000}h`
}

const variateText = (text) => {
  const emojis = ['✨', '✅', '🔥', '🚀', '📌', '🧠']
  const zwsp = '\u200B'
  const emoji = emojis[Math.floor(Math.random() * emojis.length)]
  const rand = Math.floor(Math.random() * 3)
  return rand === 0 ? text + ' ' + emoji
    : rand === 1 ? text.replace(/\s/g, m => m + (Math.random() > 0.8 ? zwsp : ''))
    : text
}

const delay = ms => new Promise(res => setTimeout(res, ms))

// Ambil teks komand dari berbagai tipe pesan
const extractTextFromMessage = (message) => {
  if (!message) return ''
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage && message.extendedTextMessage.text) return message.extendedTextMessage.text
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption
  if (message.videoMessage && message.videoMessage.caption) return message.videoMessage.caption
  if (message.listResponseMessage && message.listResponseMessage.singleSelectReply && message.listResponseMessage.singleSelectReply.selectedRowId) return message.listResponseMessage.singleSelectReply.selectedRowId
  if (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedButtonId) return message.buttonsResponseMessage.selectedButtonId
  return ''
}

// ====== BROADCAST ======
const kirimBroadcast = async (sock) => {
  if (!currentText || !currentIntervalMs) return

  const groups = await sock.groupFetchAllParticipating()
  const ids = Object.keys(groups)

  let success = 0, failed = 0, locked = []

  for (const id of ids) {
    const info = groups[id]
    if (info?.announce) {
      locked.push(`🔒 ${info.subject}`)
      continue
    }
    try {
      await sock.sendMessage(id, { text: variateText(currentText) })
      success++
    } catch (e) {
      failed++
    }
    await delay(Math.random() * 3000 + 1500)
  }

  let laporan = `📢 Laporan Broadcast:\n\n✅ Terkirim: ${success}\n❌ Gagal: ${failed}\n🔒 Grup Terkunci: ${locked.length}`
  if (locked.length) laporan += '\n\n' + locked.join('\n')

  try {
    await sock.sendMessage(OWNER_NUMBER, { text: laporan })
  } catch (err) {
    console.log('❌ Gagal kirim laporan ke owner:', err.message)
  }
}

const startBroadcastLoop = (sock) => {
  if (broadcastInterval) clearInterval(broadcastInterval)
  broadcastInterval = setInterval(() => kirimBroadcast(sock), currentIntervalMs)
}

// ====== START BOT ======
const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
    // jangan pakai shouldIgnoreJid di sini — kita lakukan filter manual di messages.upsert
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        console.clear()
        console.log(`📅 ${new Date().toLocaleString()} | 📌 Scan QR berikut untuk menghubungkan bot:\n`)
        qrcode.generate(qr, { small: true })
        console.log('\n💡 Gunakan WhatsApp untuk scan QR ini.')
      } catch (err) {
        console.error('❌ Gagal menampilkan QR:', err.message)
      }
    }

    if (connection === 'open') {
      console.log('✅ Bot aktif')
      try { await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah.' }) } catch {}
      if (broadcastActive) {
        try { await sock.sendMessage(OWNER_NUMBER, { text: `♻️ Melanjutkan broadcast...\nInterval: ${humanInterval(currentIntervalMs)}` }) } catch {}
        await kirimBroadcast(sock)
        startBroadcastLoop(sock)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...')
        // tunggu sedikit sebelum reconnect untuk mencegah rapid-restarts
        await delay(1500)
        startBot()
      } else {
        process.exit(1)
      }
    }
  })

  // ====== HANDLE PESAN DARI OWNER SAJA ======
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!Array.isArray(messages)) return
    for (const msg of messages) {
      try {
        if (!msg || !msg.message || msg.key?.fromMe) continue

        // tentukan pengirim: participant (group) atau remoteJid (1:1)
        const senderJid = msg.key.participant || msg.key.remoteJid
        // bandingkan hanya bagian sebelum @ (nomor) agar lebih robust
        if (jidBase(senderJid) !== jidBase(OWNER_NUMBER)) continue

        // Ambil teks dari message
        const teks = extractTextFromMessage(msg.message).trim()
        if (!teks) continue

        const reply = async (text) => {
          try {
            await sock.sendMessage(OWNER_NUMBER, { text })
          } catch (e) { /* jangan crash kalau gagal kirim reply */ }
        }

        // COMMANDS
        if (teks.startsWith('.settext ')) {
          currentText = teks.slice(9).trim()
          saveConfig()
          await reply('✅ Pesan disimpan.')
          continue
        }

        if (teks.startsWith('.setinterval ')) {
          const val = parseInterval(teks.slice(13).trim())
          if (!val) {
            await reply('❌ Format salah. Contoh: `.setinterval 5m`')
          } else {
            currentIntervalMs = val
            saveConfig()
            await reply(`✅ Interval diset: ${humanInterval(val)}`)
          }
          continue
        }

        if (teks === '.start') {
          if (!currentText) { await reply('❌ Set pesan dulu dengan `.settext`'); continue }
          if (broadcastActive) { await reply('❌ Broadcast sudah aktif.'); continue }
          broadcastActive = true
          saveConfig()
          await reply(`🚀 Broadcast dimulai. Interval: ${humanInterval(currentIntervalMs)}`)
          await kirimBroadcast(sock)
          startBroadcastLoop(sock)
          continue
        }

        if (teks === '.stop') {
          if (!broadcastActive) { await reply('❌ Broadcast belum aktif.'); continue }
          clearInterval(broadcastInterval)
          broadcastActive = false
          saveConfig()
          await reply('🛑 Broadcast dihentikan.')
          continue
        }

        if (teks === '.status') {
          await reply(`📊 Status:\n\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nPesan: ${currentText || '⚠️ Belum diset!'}`)
          continue
        }

        if (teks === '.totalgrup') {
          const groups = await sock.groupFetchAllParticipating()
          await reply(`📦 Total grup: ${Object.keys(groups).length}`)
          continue
        }

        if (teks.startsWith('.join ')) {
          const links = teks.split(/\s+/).filter(l => l.includes('chat.whatsapp.com'))
          if (links.length === 0) { await reply('❌ Tidak ada link grup yang valid.'); continue }

          for (const link of links) {
            const code = link.trim().split('/').pop().split('?')[0]
            try {
              await sock.groupAcceptInvite(code)
              await reply(`✅ Berhasil join grup dari link:\n${link}`)
            } catch (e) {
              await reply(`❌ Gagal join grup dari link:\n${link}`)
            }
            await delay(3000)
          }
          continue
        }

      } catch (err) {
        // jangan crash seluruh bot karena satu pesan error
        console.log('⚠️ Error memproses pesan owner:', err.message)
      }
    }
  })
}

startBot()