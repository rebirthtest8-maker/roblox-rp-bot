// ============================================================
//  BOT PODAŃ BYDGOSZCZ RP — uproszczona wersja (Railway + Volume)
//  Zawiera TYLKO: system podań (webhook + akceptacja/odrzucenie)
// ============================================================
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes
} = require('discord.js');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ==================== KONFIGURACJA ====================
// Wypełnij plik .env (przykład w .env.example)
const TOKEN              = process.env.DISCORD_TOKEN;
const GUILD_ID           = process.env.GUILD_ID;
const APPLICATION_CHANNEL_ID = process.env.APPLICATION_CHANNEL_ID;
const ROLE_IDS           = (process.env.ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean); // np. "111,222,333"
const REJECTION_CHANNEL_ID = process.env.REJECTION_CHANNEL_ID || ''; // opcjonalny kanał logów odrzuceń
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const PORT               = process.env.PORT || 3000;
const DB_PATH            = process.env.DB_PATH || './data/bot.db';   // na Volume: /data/bot.db
const LOGO_URL           = process.env.LOGO_URL || 'https://cdn.discordapp.com/attachments/1458932683676586294/1557822815028117584/removebg.png';
const EMBED_COLOR        = 0x2980b9; // Bydgoszcz RP Blue

if (!TOKEN || !GUILD_ID || !APPLICATION_CHANNEL_ID || ROLE_IDS.length === 0 || !WEBHOOK_SECRET) {
  console.error('❌ BŁĄD: Brak wymaganych zmiennych w .env (DISCORD_TOKEN, GUILD_ID, APPLICATION_CHANNEL_ID, ROLE_IDS, WEBHOOK_SECRET)');
  process.exit(1);
}

// Bezpieczne tworzenie katalogu bazy danych (ważne dla Railway Volume)
const dbDir = path.dirname(DB_PATH);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ==================== BAZA DANYCH ====================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Tabela historii podań — wszystko się zapisuje
db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discordNick TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending',        -- pending / accepted / rejected
    decidedBy TEXT,
    decidedAt INTEGER,
    createdAt INTEGER NOT NULL
  )
`);

const insertAppStmt = db.prepare(`
  INSERT INTO applications (discordNick, payload, status, createdAt)
  VALUES (@discordNick, @payload, 'pending', @createdAt)
`);
const getAppStmt = db.prepare('SELECT * FROM applications WHERE id = ?');
const setStatusStmt = db.prepare(`
  UPDATE applications SET status = ?, decidedBy = ?, decidedAt = ?
  WHERE id = ?
`);

// ==================== DISORD CLIENT ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ==================== SERWER WEB (WEBHOOK Z FORMULARZA) ====================
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));

// Endpoint kontrolny — Railway sprawdza czy bot żyje
app.get('/', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime() });
});

// Główny endpoint odbierający formularz
app.post('/api/submit', async (req, res) => {
  try {
    // Weryfikacja sekretu
    if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { answers, timestamp } = req.body;
    if (!answers) return res.status(400).json({ error: 'Brak danych (answers)' });

    const discordNick = String(answers.q3 || '').trim();
    if (!discordNick) return res.status(400).json({ error: 'Brak nicku Discord (q3)' });

    // Zapis do bazy
    const appId = insertAppStmt.run({
      discordNick,
      payload: JSON.stringify(answers),
      createdAt: Date.now()
    }).lastInsertRowid;

    const channel = await client.channels.fetch(APPLICATION_CHANNEL_ID);
    if (!channel) return res.status(500).json({ error: 'Nie znaleziono kanału podań' });

    const t = (s, max = 512) => `\`\`\`${String(s || 'Brak').substring(0, max)}\`\`\``;

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('🛡️ NOWE PODANIE DO ADMINISTRACJI BYDGOSZCZ RP')
      .setDescription('Wyższa administracja proszona jest o analizę i podjęcie decyzji przyciskami pod wiadomością.')
      .setThumbnail(LOGO_URL)
      .addFields(
        { name: '👤 Dane Główne (IC & OOC)', value: `>>> **Imię i Nazwisko:** \`${answers.q1 || 'Brak'}\`\n**Wiek:** \`${answers.q2 || 'Brak'}\`\n**Nick Discord:** \`${answers.q3 || 'Brak'}\`\n**ID Discord:** \`${req.body.discordId || 'Brak'}\``, inline: false },
        { name: '⏰ Aktywność i Doświadczenie', value: `>>> **Godziny dziennie:** \`${answers.q4 || 'Brak'}\`\n**Doświadczenie w administracji:** \`${answers.q5 || 'Brak'}\``, inline: false },
        { name: '❓ Dlaczego administracja Bydgoszcz RP?', value: t(answers.q6) },
        { name: '📚 Znajomość zasad i zadań administracji', value: t(answers.q7) },
        { name: '💪 Mocne strony / Dlaczego Ty?', value: `>>> **Mocne strony:**\n${t(answers.q8)}\n**Dlaczego Ty:**\n${t(answers.q9)}` },
        { name: '🎮 Scenariusz: gracz łamie regulamin', value: t(answers.q10) },
        { name: '🎮 Scenariusz: konflikt o RDM', value: t(answers.q11) },
        { name: '🎮 Scenariusz: znajomy łamie regulamin', value: t(answers.q12) },
        { name: '📋 Postępowanie z podejrzeniem cheatów', value: t(answers.q13) },
        { name: '👆 Reakcja na polecenia wyższej rangi', value: t(answers.q14) },
        { name: '⚖️ Regulamin', value: `> **Znajomość regulaminu:** ${answers.q19 || 'Brak'}\n> **Zobowiązanie do przestrzegania:** ${answers.q20 || 'Brak'}`, inline: false }
      )
      .setFooter({ text: `Kandydat: ${answers.q3 || 'Nieznany'} • Bydgoszcz RP • ID podania: ${appId}` })
      .setTimestamp(timestamp ? new Date(timestamp) : new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`app_accept_${appId}`).setLabel('Zaakceptuj').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId(`app_reject_${appId}`).setLabel('Odrzuć').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    await channel.send({ embeds: [embed], components: [row] });
    res.json({ success: true, id: appId });
  } catch (err) {
    console.error('❌ Błąd /api/submit:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== INTERAKCJE (przyciski) ====================
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const isAccept = interaction.customId.startsWith('app_accept_');
    const isReject = interaction.customId.startsWith('app_reject_');
    if (!isAccept && !isReject) return;

    // Ochrona przed podwójnym kliknięciem
    if (!interaction.message.components.length) {
      return interaction.reply({ content: '❌ To podanie zostało już rozpatrzone.', ephemeral: true });
    }

    const appId = parseInt(interaction.customId.split('_').pop(), 10);
    const row = getAppStmt.get(appId);
    if (!row || row.status !== 'pending') {
      return interaction.reply({ content: '❌ Podanie nie istnieje lub zostało już rozpatrzone.', ephemeral: true });
    }

    // Tylko rola rekrutacyjna (pierwsza z ROLE_IDS) lub administrator może decydować
    const recruiterRoleId = ROLE_IDS[0];
    const hasRecruiterRole = interaction.member.roles.cache.has(recruiterRoleId);
    const isAdmin = interaction.memberPermissions.has('Administrator');
    if (!hasRecruiterRole && !isAdmin) {
      return interaction.reply({ content: '❌ Brak uprawnień rekrutacyjnych.', ephemeral: true });
    }

    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    const member = members.find(m => m.user.username.toLowerCase() === row.discordNick.toLowerCase());

    // Zapis decyzji do bazy
    setStatusStmt.run(isAccept ? 'accepted' : 'rejected', interaction.user.id, Date.now(), appId);

    // Oznaczenie embeda
    const updated = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(isAccept ? 0x2ecc71 : 0xdc3545)
      .setTitle(isAccept ? '🛡️ PODANIE ZAAKCEPTOWANE' : '🛡️ PODANIE ODRZUCONE')
      .setFooter({ text: `Rozpatrzone przez: ${interaction.user.tag} • ID: ${appId}` });
    await interaction.message.edit({ embeds: [updated], components: [] });

    if (isAccept) {
      if (!member) {
        return interaction.reply({ content: '⚠️ Podanie zapisane, ale kandydat opuścił serwer — nie nadano ról.', ephemeral: true });
      }
      await member.roles.add(ROLE_IDS).catch(() => {});
      await member.send({
        embeds: [new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ PODANIE ZAAKCEPTOWANE!')
          .setDescription(`Gratulacje! Twoje podanie do administracji Bydgoszcz RP zostało zaakceptowane przez ${interaction.user.tag}.\nZgłoś się na serwerze po dalsze instrukcje.`)]
      }).catch(() => {});
      return interaction.reply({ content: `✅ Kandydat ${member.user.tag} przyjęty.`, ephemeral: true });
    } else {
      if (REJECTION_CHANNEL_ID) {
        const rejChannel = await client.channels.fetch(REJECTION_CHANNEL_ID).catch(() => null);
        if (rejChannel) {
          await rejChannel.send({
            embeds: [new EmbedBuilder()
              .setColor(0xdc3545)
              .setTitle('❌ PODANIE ODRZUCONE')
              .addFields(
                { name: 'Kandydat', value: row.discordNick, inline: true },
                { name: 'Decyzja podjęta przez', value: interaction.user.tag, inline: true }
              )
              .setTimestamp()]
          }).catch(() => {});
        }
      }
      if (member) {
        await member.send({
          embeds: [new EmbedBuilder()
            .setColor(0xdc3545)
            .setTitle('❌ PODANIE ODRZUCONE')
            .setDescription('Dziękujemy za poświęcony czas. Twoje podanie do administracji Bydgoszcz RP zostało odrzucone.')]
        }).catch(() => {});
      }
      return interaction.reply({ content: '❌ Podanie odrzucone.', ephemeral: true });
    }
  } catch (err) {
    console.error('Błąd interakcji:', err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: '❌ Wystąpił błąd.', ephemeral: true }).catch(() => {});
    }
  }
});

// ==================== URUCHOMIENIE ====================
client.once('ready', async () => {
  console.log(`🤖 Zalogowano jako ${client.user.tag}`);

  // Rejestracja komend ukośników (prosta komenda /status do sprawdzenia bota)
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const commands = [
      {
        name: 'status',
        description: 'Sprawdź status bota podań',
        options: [
          {
            name: 'podanie',
            description: 'ID podania do sprawdzenia (opcjonalne)',
            type: 4,
            required: false
          }
        ]
      }
    ];
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('✅ Komenda /status zarejestrowana.');
  } catch (err) {
    console.error('Błąd rejestracji komend:', err);
  }
});

// Komenda /status — przeglądanie podań z bazy
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'status') return;
  try {
    const id = interaction.options.getInteger('podanie');
    if (id) {
      const row = getAppStmt.get(id);
      if (!row) return interaction.reply({ content: '❌ Nie znaleziono podania.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setColor(row.status === 'accepted' ? 0x2ecc71 : row.status === 'rejected' ? 0xdc3545 : EMBED_COLOR)
        .setTitle(`📋 Podanie #${row.id} — ${row.status.toUpperCase()}`)
        .addFields(
          { name: 'Nick Discord', value: row.discordNick, inline: true },
          { name: 'Złożono', value: new Date(row.createdAt).toLocaleString('pl-PL'), inline: true }
        );
      if (row.decidedBy) embed.addFields({ name: 'Rozpatrzone przez', value: `<@${row.decidedBy}>`, inline: true });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const counts = db.prepare(`
      SELECT status, COUNT(*) as c FROM applications GROUP BY status
    `).all();
    const total = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('📊 STATUS BOTA PODAŃ')
      .setDescription(
        `**Wszystkie podania:** ${total}\n` +
        counts.map(r => `> **${r.status}:** ${r.c}`).join('\n')
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    console.error('Błąd /status:', err);
    await interaction.reply({ content: '❌ Błąd.', ephemeral: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`🌐 Serwer webowy nasłuchuje na porcie ${PORT}`));
client.login(TOKEN);
