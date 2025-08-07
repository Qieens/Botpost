process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')

const OWNER_NUMBER = '628975539822@s.whatsapp.net' // Ganti dengan nomor kamu
const CONFIG_PATH = './config.json'

let config = { currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false }
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH)) } catch {}
}
let { currentText, currentIntervalMs, broadcastActive } = config
let broadcastInterval

const saveConfig = () => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ currentText, currentIntervalMs, broadcastActive }, null, 2))
}

const parseInterval = (text) => {
  const match = text.match(/^(\d+)(s|m|h)$/i)
  if (!match) return null
  const [, val, unit] = match
  const num = parseInt(val)
  return unit === 's' ? num * 1000 : unit === 'm' ? num * 60000 : num * 3600000
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

const kirimBroadcast = async (sock) => {
  if (!currentText || !currentIntervalMs) return

  const groups = await sock.groupFetchAllParticipating()
  const ids = Object.keys(groups)

  let success = 0, failed = 0, locked = []

  for (const id of ids) {
    const info = groups[id]
    if (info.announce) {
      locked.push(`🔒 ${info.subject}`)
      continue
    }
    try {
      await sock.sendMessage(id, { text: variateText(currentText) })
      success++
    } catch {
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

const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    shouldIgnoreJid: jid => jid !== OWNER_NUMBER // Hanya baca pesan dari owner
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('✅ Bot aktif')
      await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah.' })

      if (broadcastActive) {
        await sock.sendMessage(OWNER_NUMBER, { text: `♻️ Melanjutkan broadcast...\nInterval: ${humanInterval(currentIntervalMs)}` })
        await kirimBroadcast(sock)
        startBroadcastLoop(sock)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...')
        startBot()
      } else {
        process.exit(1)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid !== OWNER_NUMBER) return

    const teks = msg.message.conversation || msg.message?.extendedTextMessage?.text || ''
    const reply = (text) => sock.sendMessage(OWNER_NUMBER, { text })

    if (teks.startsWith('.settext ')) {
      currentText = teks.slice(9).trim()
      saveConfig()
      return reply('✅ Pesan disimpan.')
    }

    if (teks.startsWith('.setinterval ')) {
      const val = parseInterval(teks.slice(13).trim())
      if (!val) return reply('❌ Format salah. Contoh: `.setinterval 5m`')
      currentIntervalMs = val
      saveConfig()
      return reply(`✅ Interval diset: ${humanInterval(val)}`)
    }

    if (teks === '.start') {
      if (!currentText) return reply('❌ Set pesan dulu dengan `.settext`')
      if (broadcastActive) return reply('❌ Broadcast sudah aktif.')
      broadcastActive = true
      saveConfig()
      reply(`🚀 Broadcast dimulai. Interval: ${humanInterval(currentIntervalMs)}`)
      await kirimBroadcast(sock)
      startBroadcastLoop(sock)
    }

    if (teks === '.stop') {
      if (!broadcastActive) return reply('❌ Broadcast belum aktif.')
      clearInterval(broadcastInterval)
      broadcastActive = false
      saveConfig()
      return reply('🛑 Broadcast dihentikan.')
    }

    if (teks === '.status') {
      return reply(`📊 Status:\n\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nPesan: ${currentText || '⚠️ Belum diset!'}`)
    }

    if (teks === '.totalgrup') {
      const groups = await sock.groupFetchAllParticipating()
      return reply(`📦 Total grup: ${Object.keys(groups).length}`)
    }

    if (teks.startsWith('.join ')) {
  const link = teks.split(' ')[1]
  if (!link || !link.includes('chat.whatsapp.com')) return reply('❌ Link tidak valid.')
  const code = link.trim().split('/').pop().split('?')[0] // ⬅ FIX: ambil hanya kode sebelum tanda ?
  try {
    await sock.groupAcceptInvite(code)
    reply('✅ Berhasil join grup.')
  } catch {
    reply('❌ Gagal join. Mungkin link kadaluarsa atau bot diblokir admin.')
  }
}
    
  })
}

startBot()