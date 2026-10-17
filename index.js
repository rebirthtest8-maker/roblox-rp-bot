const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
  TextInputStyle, REST, Routes, Partials, PermissionFlagsBits 
} = require('discord.js');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DB_PATH = process.env.DB_PATH || './data/bot.db';

// Konfiguracja ID serwera
const VERIFY_ROLES = [
  '1560936992915853443', '1560924079060684932', '1560924892432695296', 
  '1560925102638374963', '1560927670643068979'
];
const CH_PANEL = '1560930823727882281';
const CH_DOWODY = '1560931022592417834';
const CH_POJAZDY = '1560931141182292048';
const ROLE_RP = '1560927722711158835';
const CH_RP = '1560928873280176238';

// Konfiguracja bazy danych SQLite zoptymalizowanej pod Railway Volumes
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    discordId TEXT PRIMARY KEY,
    robloxId TEXT,
    robloxUsername TEXT,
    verifyCode TEXT
  );
  CREATE TABLE IF NOT EXISTS ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discordId TEXT,
    fullName TEXT,
    birthAndAge TEXT,
    citizenship TEXT,
    robloxAvatar TEXT,
    slotNumber INTEGER
  );
  CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discordId TEXT,
    brand TEXT,
    owner TEXT,
    plate TEXT
  );
  CREATE TABLE IF NOT EXISTS scheduled_rp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plannerName TEXT,
    dateTimeEpoch INTEGER,
    dateStr TEXT,
    timeStr TEXT,
    status TEXT DEFAULT 'active'
  );
`);

// Bezpieczne intencje — nie obciążają bota i eliminują błędy autoryzacji
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Pętla sprawdzająca czas RP (start i ping @everyone)
setInterval(async () => {
  const now = Math.floor(Date.now() / 1000);
  const pendingRps = db.prepare('SELECT * FROM scheduled_rp WHERE status = "active" AND dateTimeEpoch <= ?').all(now);

  for (const rp of pendingRps) {
    db.prepare('UPDATE scheduled_rp SET status = "started" WHERE id = ?').run(rp.id);
    try {
      const channel = await client.channels.fetch(CH_RP);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('🚨 ROZPOCZĘCIE ROLEPLAY')
          .setDescription(`Zaplanowane przez **${rp.plannerName}** wydarzenie RolePlay właśnie się **rozpoczęło**! Zapraszamy do gry!`)
          .setTimestamp();
        await channel.send({ content: '@everyone', embeds: [embed] });
      }
    } catch (e) {
      console.error('Błąd podczas wysyłania powiadomienia o starcie RP:', e);
    }
  }
}, 15000);

client.once('ready', async () => {
  console.log(`🤖 Bot zalogowany pomyślnie jako: ${client.user.tag}`);
  
  const commands = [
    { name: 'setup', description: 'Wysyła panel weryfikacji, dowodów i rejestracji pojazdów (Admin)' },
    {
      name: 'zaplanuj-rp',
      description: 'Zaplanuj nadchodzące RolePlay',
      options: [
        { name: 'kto', description: 'Kto planuje?', type: 3, required: true },
        { name: 'godzina', description: 'Godzina GMT+2 (np. 11:21)', type: 3, required: true },
        { name: 'data', description: 'Data w formacie DD/MM/YYYY (np. 24/10/2026)', type: 3, required: true }
      ]
    }
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('✅ Zarejestrowano komendy slash na serwerze!');
  } catch (err) {
    console.error('Błąd rejestracji komend:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Ta komenda wymaga uprawnień administratora.', ephemeral: true });
        }
        
        const embed = new EmbedBuilder()
          .setColor(0xF26522)
          .setTitle('🏙️ URZĄD MIASTA — PANEL USŁUG')
          .setDescription('Wybierz odpowiednią opcję poniżej, aby zweryfikować konto Roblox, wyrobić dowód tożsamości lub zarejestrować pojazd.');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('btn_verify').setLabel('Zweryfikuj Roblox').setStyle(ButtonStyle.Success).setEmoji('🔗'),
          new ButtonBuilder().setCustomId('btn_id').setLabel('Wyrób Dowód').setStyle(ButtonStyle.Primary).setEmoji('🪪'),
          new ButtonBuilder().setCustomId('btn_car').setLabel('Rejestracja Pojazdu').setStyle(ButtonStyle.Secondary).setEmoji('🚗')
        );

        const targetCh = await client.channels.fetch(CH_PANEL);
        await targetCh.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: '✅ Panel główny został wysłany na wyznaczony kanał!', ephemeral: true });
      }

      if (interaction.commandName === 'zaplanuj-rp') {
        if (!interaction.member.roles.cache.has(ROLE_RP) && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Nie posiadasz rangi uprawniającej do planowania RP!', ephemeral: true });
        }

        const kto = interaction.options.getString('kto');
        const godzina = interaction.options.getString('godzina');
        const dataStr = interaction.options.getString('data');

        const [day, month, year] = dataStr.split('/');
        const [hour, minute] = godzina.split(':');
        const eventDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+02:00`);

        if (isNaN(eventDate.getTime())) {
          return interaction.reply({ content: '❌ Niepoprawny format daty (użyj DD/MM/YYYY) lub godziny (użyj GG:MM)!', ephemeral: true });
        }

        const epoch = Math.floor(eventDate.getTime() / 1000);

        // Sprawdzanie czy istnieje już aktywne RP
        const activeRp = db.prepare('SELECT * FROM scheduled_rp WHERE status = "active"').get();
        if (activeRp) {
          const manageRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`rp_reschedule_${kto}_${epoch}_${dataStr}_${godzina}`).setLabel('Przełóż').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('rp_cancel_active').setLabel('Anuluj').setStyle(ButtonStyle.Danger)
          );
          return interaction.reply({
            content: `⚠️ Istnieje już zaplanowane RolePlay na <t:${activeRp.dateTimeEpoch}:F> (<t:${activeRp.dateTimeEpoch}:R>).\nWybierz działanie:`,
            components: [manageRow],
            ephemeral: true
          });
        }

        const confirmEmbed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle('⚠️ Potwierdzenie planowania RP')
          .setDescription(`Czy na pewno wszystkie dane są poprawne?\n\n**Organizator:** ${kto}\n**Data:** ${dataStr}\n**Godzina (GMT+2):** ${godzina}\n**Rozpoczęcie:** <t:${epoch}:F> (<t:${epoch}:R>)`);

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rp_confirm_${kto}_${epoch}_${dataStr}_${godzina}`).setLabel('Tak, potwierdzam').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('rp_cancel').setLabel('Anuluj').setStyle(ButtonStyle.Danger)
        );

        return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'btn_verify') {
        const modal = new ModalBuilder().setCustomId('modal_verify').setTitle('Weryfikacja Konta Roblox');
        const robloxInput = new TextInputBuilder()
          .setCustomId('roblox_nick')
          .setLabel('Twój dokładny nick z Roblox')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(robloxInput));
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_id') {
        const userCheck = db.prepare('SELECT robloxId FROM users WHERE discordId = ?').get(interaction.user.id);
        if (!userCheck) return interaction.reply({ content: '❌ Musisz najpierw przejść weryfikację konta Roblox!', ephemeral: true });

        const count = db.prepare('SELECT COUNT(*) as cnt FROM ids WHERE discordId = ?').get(interaction.user.id).cnt;
        if (count >= 2) return interaction.reply({ content: '❌ Posiadasz już maksymalną liczbę postaci (2/2)!', ephemeral: true });

        const modal = new ModalBuilder().setCustomId('modal_id').setTitle('Wyrób Dowód Osobisty');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fullname').setLabel('Imię i Nazwisko').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('birth').setLabel('Data Urodzenia i Wiek').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('citizen').setLabel('Obywatelstwo').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_car') {
        const modal = new ModalBuilder().setCustomId('modal_car').setTitle('Rejestracja Pojazdu');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('brand').setLabel('Marka Pojazdu').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('owner').setLabel('Właściciel').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('plate').setLabel('Rejestracja Pojazdu').setStyle(TextInputStyle.Short).setRequired(true))
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId.startsWith('rp_confirm_')) {
        const [, , kto, epoch, dataStr, godzina] = interaction.customId.split('_');
        
        db.prepare('INSERT INTO scheduled_rp (plannerName, dateTimeEpoch, dateStr, timeStr) VALUES (?, ?, ?, ?)').run(kto, epoch, dataStr, godzina);

        const rpChannel = await client.channels.fetch(CH_RP);
        await rpChannel.send({
          content: `@everyone Nowe wydarzenie RolePlay zostało zaplanowane!`,
          embeds: [
            new EmbedBuilder()
              .setColor(0xF26522)
              .setTitle('🗓️ Zapowiedź Wydarzenia RolePlay')
              .addFields(
                { name: 'Organizator', value: kto, inline: true },
                { name: 'Kiedy', value: `${dataStr} o ${godzina} (<t:${epoch}:R>)`, inline: true },
                { name: 'Dokładny czas', value: `<t:${epoch}:F>`, inline: false }
              )
              .setTimestamp()
          ]
        });

        return interaction.update({ content: '✅ Wydarzenie RolePlay zostało ogłoszone!', embeds: [], components: [] });
      }

      if (interaction.customId.startsWith('rp_reschedule_')) {
        const [, , kto, epoch, dataStr, godzina] = interaction.customId.split('_');
        db.prepare('UPDATE scheduled_rp SET status = "cancelled" WHERE status = "active"').run();
        db.prepare('INSERT INTO scheduled_rp (plannerName, dateTimeEpoch, dateStr, timeStr) VALUES (?, ?, ?, ?)').run(kto, epoch, dataStr, godzina);

        const rpChannel = await client.channels.fetch(CH_RP);
        await rpChannel.send({
          content: `@everyone Uwaga! Nadchodzące RolePlay zostało **przełożone**!`,
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498DB)
              .setTitle('📅 Zmiana Terminu RolePlay')
              .addFields(
                { name: 'Nowy termin', value: `${dataStr} o ${godzina} (<t:${epoch}:R>)`, inline: false }
              )
              .setTimestamp()
          ]
        });

        return interaction.update({ content: '✅ Pomyślnie zmieniono termin RolePlay.', embeds: [], components: [] });
      }

      if (interaction.customId === 'rp_cancel_active') {
        db.prepare('UPDATE scheduled_rp SET status = "cancelled" WHERE status = "active"').run();
        const rpChannel = await client.channels.fetch(CH_RP);
        await rpChannel.send({
          embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('🚫 ODWOŁANIE ROLEPLAY').setDescription('Planowane wydarzenie RolePlay zostało **odwołane**.')]
        });
        return interaction.update({ content: '✅ Aktywne RolePlay zostało odwołane.', embeds: [], components: [] });
      }

      if (interaction.customId === 'rp_cancel') {
        return interaction.update({ content: '❌ Anulowano procedurę planowania.', embeds: [], components: [] });
      }

      if (interaction.customId === 'verify_check') {
        await interaction.deferReply({ ephemeral: true });
        const userData = db.prepare('SELECT * FROM users WHERE discordId = ?').get(interaction.user.id);
        if (!userData) return interaction.editReply({ content: '❌ Błąd sesji weryfikacyjnej. Wpisz swój nick ponownie w panelu.' });

        const res = await fetch(`https://users.roblox.com/v1/users/${userData.robloxId}`);
        const json = await res.json();
        const userDescription = json.description || '';

        if (userDescription.includes(userData.verifyCode)) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await member.roles.add(VERIFY_ROLES).catch((err) => {
            console.error('Błąd nadawania ról (sprawdź pozycję roli bota):', err);
          });
          return interaction.editReply({ content: '✅ **Pomyślnie zweryfikowano!** Otrzymałeś wszystkie role obywatela.' });
        } else {
          const newCode = 'RP-' + Math.floor(100000 + Math.random() * 900000);
          db.prepare('UPDATE users SET verifyCode = ? WHERE discordId = ?').run(newCode, interaction.user.id);
          return interaction.editReply({ content: `❌ Kod nie został odnaleziony w opisie Twojego profilu Roblox!\nWygenerowano nowy kod: **${newCode}**\nWklej go w polu **About (O mnie)** i spróbuj ponownie.` });
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_verify') {
        const inputNick = interaction.fields.getTextInputValue('roblox_nick').trim();
        
        const searchRes = await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [inputNick], excludeBannedUsers: true })
        });
        const searchJson = await searchRes.json();

        if (!searchJson.data || searchJson.data.length === 0) {
          return interaction.reply({ content: '❌ Podany użytkownik Roblox nie istnieje!', ephemeral: true });
        }

        const robloxId = searchJson.data[0].id;
        const robloxUsername = searchJson.data[0].name;
        const verifyCode = 'RP-' + Math.floor(100000 + Math.random() * 900000);

        db.prepare(`
          INSERT INTO users (discordId, robloxId, robloxUsername, verifyCode) 
          VALUES (?, ?, ?, ?)
          ON CONFLICT(discordId) DO UPDATE SET robloxId = ?, robloxUsername = ?, verifyCode = ?
        `).run(interaction.user.id, robloxId, robloxUsername, verifyCode, robloxId, robloxUsername, verifyCode);

        const embed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle('🔐 Krok 2: Weryfikacja konta Roblox')
          .setDescription(`Witaj **${robloxUsername}**!\nAby potwierdzić, że konto należy do Ciebie, wejdź na Roblox w edycję profilu i wklej do sekcji **About (O mnie)** kod:\n\n\`\`\`${verifyCode}\`\`\`\nPo zapisaniu zmian na Roblox kliknij poniższy przycisk:`);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('verify_check').setLabel('Sprawdź profil').setStyle(ButtonStyle.Success)
        );

        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }

      if (interaction.customId === 'modal_id') {
        const fullName = interaction.fields.getTextInputValue('fullname');
        const birth = interaction.fields.getTextInputValue('birth');
        const citizen = interaction.fields.getTextInputValue('citizen');

        const userData = db.prepare('SELECT robloxId, robloxUsername FROM users WHERE discordId = ?').get(interaction.user.id);
        
        const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userData.robloxId}&size=420x420&format=Png&isCircular=false`);
        const thumbJson = await thumbRes.json();
        const avatarUrl = thumbJson.data[0]?.imageUrl || 'https://tr.rbxcdn.com/3943d4d7faad76e3d23f738a53e9a4f4/420/420/Image/Png';

        const count = db.prepare('SELECT COUNT(*) as cnt FROM ids WHERE discordId = ?').get(interaction.user.id).cnt + 1;

        db.prepare('INSERT INTO ids (discordId, fullName, birthAndAge, citizenship, robloxAvatar, slotNumber) VALUES (?, ?, ?, ?, ?, ?)').run(
          interaction.user.id, fullName, birth, citizen, avatarUrl, count
        );

        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('🪪 Nowy Dowód Osobisty Obywatela')
          .setThumbnail(avatarUrl)
          .addFields(
            { name: '👤 Imię i Nazwisko', value: fullName, inline: false },
            { name: '🎂 Data Urodzenia i Wiek', value: birth, inline: true },
            { name: '🌍 Obywatelstwo', value: citizen, inline: true },
            { name: '🎮 Konto Roblox', value: userData.robloxUsername, inline: false }
          )
          .setFooter({ text: `Postać ${count}/2 | Właściciel: ${interaction.user.tag}` })
          .setTimestamp();

        const targetCh = await client.channels.fetch(CH_DOWODY);
        await targetCh.send({ embeds: [embed] });

        return interaction.reply({ content: `✅ Dowód osobisty został pomyślnie wyrobiony (Postać ${count}/2)!`, ephemeral: true });
      }

      if (interaction.customId === 'modal_car') {
        const brand = interaction.fields.getTextInputValue('brand');
        const owner = interaction.fields.getTextInputValue('owner');
        const plate = interaction.fields.getTextInputValue('plate');

        db.prepare('INSERT INTO vehicles (discordId, brand, owner, plate) VALUES (?, ?, ?, ?)').run(
          interaction.user.id, brand, owner, plate
        );

        const embed = new EmbedBuilder()
          .setColor(0xE67E22)
          .setTitle('🚗 Nowy Wpis: Rejestracja Pojazdu')
          .addFields(
            { name: '🏷️ Marka Pojazdu', value: brand, inline: true },
            { name: '👤 Właściciel', value: owner, inline: true },
            { name: '🔢 Numer Rejestracyjny', value: `\`${plate}\``, inline: false }
          )
          .setFooter({ text: `Zgłaszający: ${interaction.user.tag}` })
          .setTimestamp();

        const targetCh = await client.channels.fetch(CH_POJAZDY);
        await targetCh.send({ embeds: [embed] });

        return interaction.reply({ content: '✅ Pojazd został pomyślnie zarejestrowany!', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Błąd podczas obsługi interakcji:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Wystąpił błąd podczas przetwarzania żądania.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(TOKEN);
