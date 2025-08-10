process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')

// **CONFIG**
const OWNER_NUMBER = '628975539822@s.whatsapp.net'
const CONTROL_GROUP_JID = '123456789-123456@g.us' // ganti dengan jid grup kontrol kamu

const BATCH_SIZE = 20

// ====== BOT CONFIGS ======
// Set prefix tiap bot biar bisa bedain perintah dari grup kontrol
const bots = [
  { id: 'BOT1', currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false, variateTextActive: true, broadcastTimeout: null, groupCache: {}, sessionFolder: 'session-BOT1' },
  { id: 'BOT2', currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false, variateTextActive: true, broadcastTimeout: null, groupCache: {}, sessionFolder: 'session-BOT2' }
]

// Simpan config tiap bot ke file JSON per bot
function saveConfig(bot) {
  const path = `./config_${bot.id}.json`
  fs.writeFileSync(path, JSON.stringify({
    currentText: bot.currentText,
    currentIntervalMs: bot.currentIntervalMs,
    broadcastActive: bot.broadcastActive,
    variateTextActive: bot.variateTextActive
  }, null, 2))
}

function loadConfig(bot) {
  const path = `./config_${bot.id}.json`
  if (fs.existsSync(path)) {
    try {
      const conf = JSON.parse(fs.readFileSync(path))
      bot.currentText = conf.currentText || ''
      bot.currentIntervalMs = conf.currentIntervalMs || 5 * 60 * 1000
      bot.broadcastActive = conf.broadcastActive || false
      bot.variateTextActive = conf.variateTextActive ?? true
    } catch {}
  }
}

// Utils
function parseInterval(text) {
  const match = text.match(/^(\d+)(s|m|h)$/i)
  if (!match) return null
  const num = parseInt(match[1])
  return match[2].toLowerCase() === 's' ? num * 1000 : match[2].toLowerCase() === 'm' ? num * 60000 : num * 3600000
}

function humanInterval(ms) {
  if (ms < 60000) return `${ms / 1000}s`
  if (ms < 3600000) return `${ms / 60000}m`
  return `${ms / 3600000}h`
}

function variateText(text, active) {
  if (!active) return text
  const emojis = ['✨', '✅', '🔥', '🚀', '📌', '🧠']
  const zwsp = '\u200B'
  const emoji = emojis[Math.floor(Math.random() * emojis.length)]
  const rand = Math.floor(Math.random() * 3)
  return rand === 0 ? text + ' ' + emoji
    : rand === 1 ? text.replace(/\s/g, m => m + (Math.random() > 0.8 ? zwsp : ''))
    : text
}

const delay = ms => new Promise(res => setTimeout(res, ms))

// Send broadcast batch
async function sendBatch(sock, batch, text, bot) {
  for (const jid of batch) {
    try {
      await sock.sendMessage(jid, { text: variateText(text, bot.variateTextActive) })
      console.log(`✅ [${bot.id}] Broadcast terkirim ke ${jid}`)
      await delay(300)
    } catch (err) {
      console.error(`❌ [${bot.id}] Gagal broadcast ke ${jid}:`, err.message)
    }
  }
}

// Broadcast semua grup kecuali grup kontrol
async function broadcastAll(sock, bot) {
  if (!bot.currentText) return

  const allGroups = Object.entries(bot.groupCache)
    .filter(([jid]) => jid !== CONTROL_GROUP_JID)
    .map(([jid]) => jid)

  if (allGroups.length === 0) {
    await sock.sendMessage(OWNER_NUMBER, { text: `⚠️ [${bot.id}] Tidak ada grup yang ditemukan untuk broadcast.` })
    return
  }

  const batches = []
  for (let i = 0; i < allGroups.length; i += BATCH_SIZE) {
    batches.push(allGroups.slice(i, i + BATCH_SIZE))
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    await sock.sendMessage(OWNER_NUMBER, { text: `📢 [${bot.id}] Mulai kirim batch ${i + 1} dari ${batches.length}, batch size: ${batch.length}` })
    await sendBatch(sock, batch, bot.currentText, bot)
    await sock.sendMessage(OWNER_NUMBER, { text: `✅ [${bot.id}] Batch ${i + 1} selesai.` })
    if (i < batches.length - 1) await delay(2000)
  }
}

async function startBroadcastLoop(sock, bot) {
  if (bot.broadcastTimeout) clearTimeout(bot.broadcastTimeout)
  if (!bot.broadcastActive) return

  await broadcastAll(sock, bot)
  bot.broadcastTimeout = setTimeout(() => startBroadcastLoop(sock, bot), bot.currentIntervalMs)
}

// Load config semua bot sebelum start
bots.forEach(loadConfig)

// Start socket dan logic bot per bot
async function startBotInstance(bot) {
  const { state, saveCreds } = await useMultiFileAuthState(bot.sessionFolder)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    msgRetryCounterCache: {},
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => undefined
  })

  sock.ev.on('creds.update', saveCreds)

  // Refresh group cache untuk bot ini
  let isRefreshing = false
  async function refreshGroups() {
    if (isRefreshing) return
    isRefreshing = true
    try {
      const groups = await sock.groupFetchAllParticipating()
      bot.groupCache = groups
      console.log(`🔄 [${bot.id}] Cache grup diperbarui: ${Object.keys(groups).length} grup`)
    } catch (e) {
      console.error(`[${bot.id}] Gagal refresh group cache:`, e.message)
    }
    isRefreshing = false
  }

  const debounceRefreshGroups = (() => {
    let timeout = null
    return () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(refreshGroups, 60000)
    }
  })()

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.clear()
      console.log(`📅 ${new Date().toLocaleString()} | 📌 Scan QR [${bot.id}]:\n`)
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log(`✅ [${bot.id}] Bot aktif`)
      await refreshGroups()
      await sock.sendMessage(OWNER_NUMBER, { text: `✅ [${bot.id}] Bot siap menerima perintah.` })

      // Mulai broadcast loop kalau aktif
      if (bot.broadcastActive) {
        await sock.sendMessage(OWNER_NUMBER, { text: `♻️ [${bot.id}] Melanjutkan broadcast...\nInterval: ${humanInterval(bot.currentIntervalMs)}` })
        startBroadcastLoop(sock, bot)
      }
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`🔁 [${bot.id}] Reconnecting in 5 seconds...`)
        setTimeout(() => startBotInstance(bot), 5000)
      } else {
        process.exit(1)
      }
    }
  })

  sock.ev.on('groups.update', debounceRefreshGroups)
  sock.ev.on('group-participants.update', debounceRefreshGroups)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const fromJid = msg.key.remoteJid || ''
    const isFromControlGroup = fromJid === CONTROL_GROUP_JID
    const isFromOwner = fromJid === OWNER_NUMBER

    if (!isFromControlGroup && !isFromOwner) return

    try {
      const rawText = msg.message.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || ''

      if (isFromControlGroup) {
        const prefixMatch = rawText.match(/^#(\w+)\s+(.*)$/)
        if (!prefixMatch) return
        const botId = prefixMatch[1].toUpperCase()
        const commandText = prefixMatch[2].trim()

        if (botId !== bot.id) return // hanya proses perintah untuk bot ini

        await handleCommand(sock, bot, commandText)
      } else if (isFromOwner) {
        // Owner private chat kirim perintah ke semua bot
        await handleCommand(sock, bot, rawText)
      }
    } catch (e) {
      if (e.message && e.message.includes('Failed decrypt')) {
        console.warn(`⚠️ [${bot.id}] Gagal decrypt pesan.`)
        await sock.sendMessage(OWNER_NUMBER, { text: `⚠️ [${bot.id}] Pesan gagal didekripsi, mohon kirim ulang.` }).catch(() => {})
      } else {
        console.error(`[${bot.id}] Error di messages.upsert:`, e)
      }
    }
  })

  async function handleCommand(sock, bot, teks) {
    const reply = (text) => sock.sendMessage(OWNER_NUMBER, { text: `[${bot.id}] ${text}` })

    if (teks.startsWith('.teks ')) {
      bot.currentText = teks.slice(6).trim()
      saveConfig(bot)
      return reply('✅ Pesan disimpan.')
    }

    if (teks.startsWith('.setinterval ')) {
      const val = parseInterval(teks.slice(13).trim())
      if (!val) return reply('❌ Format salah. Contoh: `.setinterval 5m`')
      bot.currentIntervalMs = val
      saveConfig(bot)
      return reply(`✅ Interval diset: ${humanInterval(val)}`)
    }

    if (teks === '.variasi on') {
      bot.variateTextActive = true
      saveConfig(bot)
      return reply('✅ Variasi teks diaktifkan.')
    }

    if (teks === '.variasi off') {
      bot.variateTextActive = false
      saveConfig(bot)
      return reply('✅ Variasi teks dinonaktifkan.')
    }

    if (teks === '.start') {
      if (!bot.currentText) return reply('❌ Set pesan dulu dengan `.teks <pesan>`')
      if (bot.broadcastActive) return reply('❌ Broadcast sudah aktif.')
      bot.broadcastActive = true
      saveConfig(bot)
      startBroadcastLoop(sock, bot)
      return
    }

    if (teks === '.stop') {
      if (!bot.broadcastActive) return reply('❌ Broadcast belum aktif.')
      bot.broadcastActive = false
      if (bot.broadcastTimeout) clearTimeout(bot.broadcastTimeout)
      saveConfig(bot)
      return reply('🛑 Broadcast dihentikan.')
    }

    if (teks === '.status') {
      return reply(`📊 Status:\n\nAktif: ${bot.broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(bot.currentIntervalMs)}\nVariasi: ${bot.variateTextActive ? '✅ Aktif' : '❌ Mati'}\nPesan: ${bot.currentText || '⚠️ Belum diset!'}`)
    }

    if (teks === '.totalgrup') {
      return reply(`📦 Total grup: ${Object.keys(bot.groupCache).length}`)
    }

    if (teks.startsWith('.join ')) {
      const links = teks.match(/https:\/\/chat\.whatsapp\.com\/[0-9A-Za-z]+/g)
      if (!links) return reply('❌ Tidak ada link grup yang valid.')

      for (const link of links) {
        const code = link.split('/').pop()
        try {
          await sock.groupAcceptInvite(code)
          await refreshGroups()
          await reply(`✅ Berhasil join grup:\n${link}`)
        } catch (err) {
          await reply(`❌ Gagal join grup:\n${link}\nAlasan: ${err.message}`)
        }
        await delay(3000)
      }
      return
    }

    reply('❌ Perintah tidak dikenali.')
  }
}

async function startAllBots() {
  for (const bot of bots) {
    startBotInstance(bot)
  }
}

startAllBots()