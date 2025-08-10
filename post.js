process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const path = require('path')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')

const OWNER_NUMBER = '628975539822@s.whatsapp.net' // ganti nomor owner kamu
const CONFIG_PATH = './config.json'
const BATCH_SIZE = 20

// ====== LOAD CONFIG ======
let config = { currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false, variatetextActive: true }
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH)) } catch {}
}
let { currentText, currentIntervalMs, broadcastActive, variatetextActive } = config
let broadcastTimeout, groupCache = {}

const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ currentText, currentIntervalMs, broadcastActive, variatetextActive }, null, 2))

// ====== UTIL ======
const parseInterval = (text) => {
  const match = text.match(/^(\d+)(s|m|h)$/i)
  if (!match) return null
  const num = parseInt(match[1])
  return match[2].toLowerCase() === 's' ? num * 1000 : match[2].toLowerCase() === 'm' ? num * 60000 : num * 3600000
}

const humanInterval = (ms) => {
  if (ms < 60000) return `${ms / 1000}s`
  if (ms < 3600000) return `${ms / 60000}m`
  return `${ms / 3600000}h`
}

const variateText = (text) => {
  if (!variatetextActive) return text
  const emojis = ['✨', '✅', '🔥', '🚀', '📌', '🧠']
  const zwsp = '\u200B'
  const emoji = emojis[Math.floor(Math.random() * emojis.length)]
  const rand = Math.floor(Math.random() * 3)
  return rand === 0 ? text + ' ' + emoji
    : rand === 1 ? text.replace(/\s/g, m => m + (Math.random() > 0.8 ? zwsp : ''))
    : text
}

const delay = ms => new Promise(res => setTimeout(res, ms))

// ====== BROADCAST ======

async function sendBatch(sock, batch, text) {
  for (const jid of batch) {
    try {
      await sock.sendMessage(jid, { text: variateText(text) })
      console.log(`✅ Broadcast terkirim ke ${jid}`)
      await delay(300)
    } catch (err) {
      console.error(`❌ Gagal broadcast ke ${jid}:`, err.message)
    }
  }
}

async function refreshGroups(sock) {
  try {
    groupCache = await sock.groupFetchAllParticipating()
    console.log(`🔄 Cache grup diperbarui: ${Object.keys(groupCache).length} grup`)
  } catch (err) {
    console.error('Gagal refresh group cache:', err.message)
  }
}

async function broadcastAll(sock) {
  if (!currentText) return

  let sentGroups = new Set()

  while (true) {
    const allGroups = Object.entries(groupCache)
      .filter(([jid, info]) => !info.announce && !sentGroups.has(jid))
      .map(([jid]) => jid)

    if (allGroups.length === 0) {
      await sock.sendMessage(OWNER_NUMBER, { text: '✅ Semua grup sudah dikirimi broadcast.' })
      break
    }

    const batch = allGroups.slice(0, BATCH_SIZE)

    await sock.sendMessage(OWNER_NUMBER, { text: `📢 Mulai kirim batch, ukuran batch: ${batch.length}` })
    await sendBatch(sock, batch, currentText)
    await sock.sendMessage(OWNER_NUMBER, { text: `✅ Batch selesai dikirim.` })

    batch.forEach(jid => sentGroups.add(jid))

    await refreshGroups(sock) // refresh cache setelah batch selesai

    await delay(2000)
  }
}

// ====== KONEKSI ======
let isConnected = false

// Flag untuk menghindari multiple broadcast loops
let isBroadcastRunning = false

async function startBroadcastLoop(sock) {
  if (broadcastTimeout) clearTimeout(broadcastTimeout)
  if (isBroadcastRunning) return
  isBroadcastRunning = true

  // Refresh grup sekali saat start loop
  await refreshGroups(sock)

  async function loop() {
    if (!broadcastActive) {
      isBroadcastRunning = false
      return
    }

    if (!isConnected) {
      console.log('⚠️ Koneksi belum siap, menunggu...')
      await delay(5000)
      return loop()
    }

    await broadcastAll(sock)

    await delay(currentIntervalMs)

    await refreshGroups(sock)

    return loop()
  }

  return loop()
}

// ====== START BOT ======
const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  // Event: bot masuk grup baru → refresh cache grup
  sock.ev.on('group-participants.update', async (update) => {
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
    if (update.action === 'add' && update.participants.includes(botId)) {
      console.log(`🤖 Bot masuk grup baru: ${update.id}`)
      await refreshGroups(sock)
    }
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.clear()
      console.log(`📅 ${new Date().toLocaleString()} | 📌 Scan QR:\n`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      isConnected = true
      console.log('✅ Bot aktif')
      await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah.' })

      if (broadcastActive) {
        await sock.sendMessage(OWNER_NUMBER, { text: `♻️ Melanjutkan broadcast...\nInterval: ${humanInterval(currentIntervalMs)}` })
        startBroadcastLoop(sock)
      }
    }

    if (connection === 'close') {
      isConnected = false
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log(`❌ Connection closed, code: ${reason}`)

      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting in 5 seconds...')
        setTimeout(() => startBot(), 5000)
      } else {
        console.log('⚠️ Session logged out, silakan scan ulang QR')
        process.exit(1)
      }
    }
  })

  // Untuk mencegah spam pesan gagal decrypt ke owner
  let lastDecryptWarn = 0
  const decryptWarnInterval = 60 * 1000 // 1 menit

  // Untuk tracking error decrypt banyak dalam 1 menit
  let decryptErrorCount = 0
  let decryptErrorResetTimeout = null
  const DECRYPT_ERROR_THRESHOLD = 5
  const DECRYPT_ERROR_RESET_TIME = 60000 // 1 menit

  // Handle messages dari owner saja
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const jid = msg.key.remoteJid || ''
    const fromOwner = jid === OWNER_NUMBER
    const isGroup = jid.endsWith('.g.us')

    if (isGroup && !fromOwner) return
    if (!fromOwner) return

    try {
      const teks = msg.message.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || ''

      const reply = (text) => sock.sendMessage(OWNER_NUMBER, { text })

      // Reset decrypt error count jika pesan berhasil diproses
      if (decryptErrorCount > 0) {
        decryptErrorCount = 0
        if (decryptErrorResetTimeout) {
          clearTimeout(decryptErrorResetTimeout)
          decryptErrorResetTimeout = null
        }
      }

      if (teks.startsWith('.teks ')) {
        currentText = teks.slice(6).trim()
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

      if (teks === '.variasi on') {
        variatetextActive = true
        saveConfig()
        return reply('✅ Variasi teks diaktifkan.')
      }

      if (teks === '.variasi off') {
        variatetextActive = false
        saveConfig()
        return reply('✅ Variasi teks dinonaktifkan.')
      }

      if (teks === '.start') {
        if (!currentText) return reply('❌ Set pesan dulu dengan `.teks <pesan>`')
        if (broadcastActive) return reply('❌ Broadcast sudah aktif.')
        broadcastActive = true
        saveConfig()
        startBroadcastLoop(sock)
        return reply('✅ Broadcast dimulai.')
      }

      if (teks === '.stop') {
        if (!broadcastActive) return reply('❌ Broadcast belum aktif.')
        broadcastActive = false
        if (broadcastTimeout) clearTimeout(broadcastTimeout)
        saveConfig()
        return reply('🛑 Broadcast dihentikan.')
      }

      if (teks === '.status') {
        return reply(`📊 Status:\n\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nVariasi : ${variatetextActive ? '✅ Aktif' : '❌ Mati'}\nPesan: ${currentText || '⚠️ Belum diset!'}`)
      }
    } catch (e) {
      if (e.message && e.message.includes('Failed decrypt')) {
        decryptErrorCount++

        // Reset count tiap 1 menit
        if (decryptErrorResetTimeout) clearTimeout(decryptErrorResetTimeout)
        decryptErrorResetTimeout = setTimeout(() => {
          decryptErrorCount = 0
        }, DECRYPT_ERROR_RESET_TIME)

        console.warn(`⚠️ Gagal decrypt pesan ke-${decryptErrorCount}`)

        if (decryptErrorCount >= DECRYPT_ERROR_THRESHOLD) {
          console.error('❌ Terlalu banyak error decrypt, reset session dan restart bot...')

          try {
            fs.rmSync(path.resolve('./session'), { recursive: true, force: true })
          } catch (err) {
            console.error('Gagal hapus folder session:', err)
          }

          process.exit(1) // biar pm2 restart
        }

        // Kirim peringatan ke owner maksimal 1 menit sekali
        const now = Date.now()
        if (now - lastDecryptWarn > decryptWarnInterval) {
          lastDecryptWarn = now
          await sock.sendMessage(OWNER_NUMBER, { text: '⚠️ Pesan gagal didekripsi, mohon kirim ulang.' }).catch(() => {})
        }

        // Skip pesan error tanpa crash / lanjutkan
        return
      } else {
        console.error('Error di messages.upsert:', e)
      }
    }
  })
}

startBot()