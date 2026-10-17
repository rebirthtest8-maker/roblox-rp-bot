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

function generateNumericCode() {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `RP-${num}`;
}

// Baza danych SQLite zoptymalizowana pod Railway Volume
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

// Pętla sprawdzająca czas rozpoczęcia RP i pingująca @everyone
setInterval(async () => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const pendingRps = db.prepare('SELECT * FROM scheduled_rp WHERE status = "active" AND dateTimeEpoch <= ?').all(now);

    for (const rp of pendingRps) {
      db.prepare('UPDATE scheduled_rp SET status = "started" WHERE id = ?').run(rp.id);
      const channel = await client.channels.fetch(CH_RP).catch(() => null);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x2ECC71)
          .setTitle('🚨 ROZPOCZĘCIE ROLEPLAY')
          .setDescription(`Wydarzenie RolePlay zaplanowane przez **${rp.plannerName}** właśnie się **rozpoczęło**! Zapraszamy wszystkich do gry!`)
          .setTimestamp();
        await channel.send({ content: '@everyone', embeds: [embed] }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Błąd pętli RP:', e);
  }
}, 15000);

client.once('ready', async () => {
  console.log(`🤖 Zalogowano jako ${client.user.tag}`);
  
  const commands = [
    { name: 'setup', description: 'Wysyła główny panel weryfikacji, dowodów i pojazdów (Admin)' },
    {
      name: 'zaplanuj-rp',
      description: 'Zaplanuj nadchodzące RolePlay',
      options: [
        { name: 'kto', description: 'Kto planuje?', type: 3, required: true },
        { name: 'godzina', description: 'Godzina GMT+2 (np. 11:21)', type: 3, required: true },
        { name: 'data', description: 'Data DD/MM/YYYY (np. 24/10/2026)', type: 3, required: true }
      ]
    }
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log('✅ Zarejestrowano komendy slash!');
  } catch (err) {
    console.error('Błąd rejestracji komend slash:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    // ==================== KOMENDY SLASH ====================
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Brak uprawnień administratora.', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });

        const embed = new EmbedBuilder()
          .setColor(0xF26522)
          .setTitle('🏙️ URZĄD MIASTA — PANEL GŁÓWNY')
          .setDescription('Wybierz jedną z opcji poniżej, aby zweryfikować konto Roblox, wyrobić dowód tożsamości lub zarejestrować swój pojazd.');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('btn_verify').setLabel('Zweryfikuj Roblox').setStyle(ButtonStyle.Success).setEmoji('🔗'),
          new ButtonBuilder().setCustomId('btn_id').setLabel('Wyrób Dowód').setStyle(ButtonStyle.Primary).setEmoji('🪪'),
          new ButtonBuilder().setCustomId('btn_car').setLabel('Rejestracja Pojazdu').setStyle(ButtonStyle.Secondary).setEmoji('🚗')
        );

        const targetCh = await client.channels.fetch(CH_PANEL);
        await targetCh.send({ embeds: [embed], components: [row] });
        return interaction.editReply({ content: '✅ Panel został wysłany na wyznaczony kanał!' });
      }

      if (interaction.commandName === 'zaplanuj-rp') {
        if (!interaction.member.roles.cache.has(ROLE_RP) && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ Brak uprawnień do planowania RP.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const kto = interaction.options.getString('kto');
        const godzina = interaction.options.getString('godzina');
        const dataStr = interaction.options.getString('data');

        const [day, month, year] = dataStr.split('/');
        const [hour, minute] = godzina.split(':');
        const eventDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+02:00`);

        if (isNaN(eventDate.getTime())) {
          return interaction.editReply({ content: '❌ Błędny format daty (użyj DD/MM/YYYY) lub godziny (użyj GG:MM)!' });
        }

        const epoch = Math.floor(eventDate.getTime() / 1000);

        const activeRp = db.prepare('SELECT * FROM scheduled_rp WHERE status = "active"').get();
        if (activeRp) {
          const manageRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`rp_reschedule_${kto}_${epoch}_${dataStr}_${godzina}`).setLabel('Przełóż').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('rp_cancel_active').setLabel('Anuluj').setStyle(ButtonStyle.Danger)
          );
          return interaction.editReply({
            content: `⚠️ Istnieje już aktywne RolePlay zaplanowane na <t:${activeRp.dateTimeEpoch}:F> (<t:${activeRp.dateTimeEpoch}:R>). Co chcesz zrobić?`,
            components: [manageRow]
          });
        }

        const confirmEmbed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle('⚠️ Potwierdzenie planowania RP')
          .setDescription(`Czy poniższe informacje są prawidłowe?\n\n**Organizator:** ${kto}\n**Data:** ${dataStr}\n**Godzina (GMT+2):** ${godzina}\n**Start:** <t:${epoch}:F> (<t:${epoch}:R>)`);

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rp_confirm_${kto}_${epoch}_${dataStr}_${godzina}`).setLabel('Tak, potwierdzam').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('rp_cancel').setLabel('Anuluj').setStyle(ButtonStyle.Danger)
        );

        return interaction.editReply({ embeds: [confirmEmbed], components: [confirmRow] });
      }
    }

    // ==================== OBSŁUGA PRZYCISKÓW ====================
    if (interaction.isButton()) {
      // Modale NIE MOGĄ mieć deferReply!
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
        if (!userCheck) return interaction.reply({ content: '❌ Musisz najpierw zweryfikować konto Roblox!', ephemeral: true });

        const count = db.prepare('SELECT COUNT(*) as cnt FROM ids WHERE discordId = ?').get(interaction.user.id).cnt;
        if (count >= 2) return interaction.reply({ content: '❌ Osiągnąłeś maksymalną liczbę postaci (2/2)!', ephemeral: true });

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

      // Sprawdzanie kodu weryfikacyjnego
      if (interaction.customId === 'verify_check') {
        await interaction.deferReply({ ephemeral: true });

        const userData = db.prepare('SELECT * FROM users WHERE discordId = ?').get(interaction.user.id);
        if (!userData) {
          return interaction.editReply({ content: '❌ Nie rozpoczęto procesu weryfikacji. Wpisz swój nick ponownie w panelu.' });
        }

        const targetCode = userData.verifyCode;
        const targetClean = targetCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        let fetchedDescription = '';
        let verified = false;

        // 1. Sprawdzanie przez Bloxlink API (globalna baza graczy Roblox na Discordzie)
        try {
          const blRes = await fetch(`https://api.blox.link/v4/public/guilds/${GUILD_ID}/discord-to-roblox/${interaction.user.id}`, { timeout: 3000 });
          if (blRes.ok) {
            const blData = await blRes.json();
            if (blData.robloxID && String(blData.robloxID) === String(userData.robloxId)) {
              verified = true;
            }
          }
        } catch (e) {}

        // 2. Jeśli brak w Bloxlink — sprawdzanie przez RoProxy z ominięciem blokad Cloudflare
        if (!verified) {
          try {
            const proxyRes = await fetch(`https://users.roproxy.com/v1/users/${userData.robloxId}?_=${Date.now()}`, {
              headers: { 'Cache-Control': 'no-cache' },
              timeout: 4000
            });
            if (proxyRes.ok) {
              const data = await proxyRes.json();
              fetchedDescription = data.description || '';
            }
          } catch (e) {}

          const cleanDesc = fetchedDescription.replace(/[^A-Z0-9]/gi, '').toUpperCase();
          if (cleanDesc.includes(targetClean)) {
            verified = true;
          }
        }

        if (verified) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await member.roles.add(VERIFY_ROLES).catch(err => {
            console.error('Błąd nadawania ról (upewnij się, że rola bota jest wyżej na liście serwera!):', err);
          });

          return interaction.editReply({ 
            content: `✅ **SUKCES! Konto [${userData.robloxUsername}](https://www.roblox.com/users/${userData.robloxId}/profile) zostało pomyślnie zweryfikowane!**\nNadano wszystkie 5 ról obywatela.` 
          });
        } else {
          return interaction.editReply({ 
            content: `❌ **Kod nie został jeszcze wykryty w sekcji About (O mnie).**\n\nTwój kod to:\n\`\`\`${targetCode}\`\`\`\n🔗 **Link do Twojego profilu:** https://www.roblox.com/users/${userData.robloxId}/profile\n\n**Odczytany opis z profilu:**\n> \`${fetchedDescription || '(pole jest puste lub serwery Roblox jeszcze się nie zaktualizowały)'}\`\n\n🛠️ **Wskazówki:**\n1. Otwórz powyższy link i upewnij się, że jesteś zalogowany na to konto.\n2. Wklej kod w sekcji **About (O mnie)** i wciśnij **Save**.\n3. Jeśli Roblox zamienił kod na \`###\`, wpisz go ze spacją między każdym znakiem: **\`${targetCode.split('').join(' ')}\`** (bot bez problemu go rozpozna).\n4. Odczekaj 10 sekund i kliknij przycisk ponownie.` 
          });
        }
      }

      if (interaction.customId.startsWith('rp_confirm_')) {
        await interaction.deferUpdate();
        const [, , kto, epoch, dataStr, godzina] = interaction.customId.split('_');
        
        db.prepare('INSERT INTO scheduled_rp (plannerName, dateTimeEpoch, dateStr, timeStr) VALUES (?, ?, ?, ?)').run(kto, epoch, dataStr, godzina);

        const rpChannel = await client.channels.fetch(CH_RP);
        await rpChannel.send({
          content: `@everyone Nadchodzi nowe wydarzenie RolePlay!`,
          embeds: [
            new EmbedBuilder()
              .setColor(0xF26522)
              .setTitle('🗓️ Zapowiedź Wydarzenia RolePlay')
              .addFields(
                { name: 'Organizator', value: kto, inline: true },
                { name: 'Kiedy', value: `${dataStr} o ${godzina} (<t:${epoch}:R>)`, inline: true },
                { name: 'Dokładny czas startu', value: `<t:${epoch}:F>`, inline: false }
              )
              .setTimestamp()
          ]
        });

        return interaction.editReply({ content: '✅ Wydarzenie RolePlay zostało zaplanowane!', embeds: [], components: [] });
      }

      if (interaction.customId.startsWith('rp_reschedule_')) {
        await interaction.deferUpdate();
        const [, , kto, epoch, dataStr, godzina] = interaction.customId.split('_');
        db.prepare('UPDATE scheduled_rp SET status = "cancelled" WHERE status = "active"').run();
        db.prepare('INSERT INTO scheduled_rp (plannerName, dateTimeEpoch, dateStr, timeStr) VALUES (?, ?, ?, ?)').run(kto, epoch, dataStr, godzina);

        const rpChannel = await client.channels.fetch(CH_RP);
        await rpChannel.send({
          content: `@everyone Uwaga! Nadchodzące RolePlay zostało **przełożone**!`,
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498DB)
              .setTitle('📅 Zmiana Terminu RP')
              .addFields(
                { name: 'Nowy termin', value: `${dataStr} o ${godzina} (<t:${epoch}:R>)`, inline: false }
              )
              .setTimestamp()
          ]
        });

        return interaction.editReply({ content: '✅ Pomyślnie zaktualizowano termin RP.', embeds: [], components: [] });
      }

      if (interaction.customId === 'rp_cancel_active') {
        await interaction.deferUpdate();
        db.prepare('UPDATE scheduled_rp SET status = "cancelled" WHERE status = "active"').run();
        const rpChannel = await client.channels.fetch(CH_RP);
        await rpChannel.send({
          embeds: [new EmbedBuilder().setColor(0xE74C3C).setTitle('🚫 EVENT ROLEPLAY ODWOŁANY').setDescription('Uwaga! Planowane wcześniej wydarzenie RolePlay zostało odwołane.')]
        });
        return interaction.editReply({ content: '✅ Wydarzenie zostało anulowane.', embeds: [], components: [] });
      }

      if (interaction.customId === 'rp_cancel') {
        return interaction.update({ content: '❌ Anulowano proces planowania.', embeds: [], components: [] });
      }
    }

    // ==================== OBSŁUGA FORMULARZY (MODALI) ====================
    if (interaction.isModalSubmit()) {
      // Wszystkie modale natychmiast odraczamy, aby zapobiec timeoutom
      await interaction.deferReply({ ephemeral: true });

      if (interaction.customId === 'modal_verify') {
        const inputNick = interaction.fields.getTextInputValue('roblox_nick').trim();
        
        const searchRes = await fetch('https://users.roblox.com/v1/usernames/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: [inputNick], excludeBannedUsers: true })
        });
        const searchJson = await searchRes.json();

        if (!searchJson.data || searchJson.data.length === 0) {
          return interaction.editReply({ content: '❌ Nie odnaleziono gracza o takim nicku na Roblox!' });
        }

        const robloxId = searchJson.data[0].id;
        const robloxUsername = searchJson.data[0].name;
        const verifyCode = generateNumericCode();

        db.prepare(`
          INSERT INTO users (discordId, robloxId, robloxUsername, verifyCode) 
          VALUES (?, ?, ?, ?)
          ON CONFLICT(discordId) DO UPDATE SET robloxId = ?, robloxUsername = ?, verifyCode = ?
        `).run(interaction.user.id, robloxId, robloxUsername, verifyCode, robloxId, robloxUsername, verifyCode);

        const profileUrl = `https://www.roblox.com/users/${robloxId}/profile`;

        const embed = new EmbedBuilder()
          .setColor(0xF1C40F)
          .setTitle('🔐 Krok 2: Weryfikacja konta Roblox')
          .setDescription(`Witaj **${robloxUsername}**!\n\n1. Kliknij w link do swojego profilu: **[Twój Profil Roblox](${profileUrl})**\n2. Wklej poniższy kod w polu **About (O mnie)** i zapisz zmiany:\n\n\`\`\`${verifyCode}\`\`\`\n*(W razie cenzury wpisz kod ze spacjami: \`${verifyCode.split('').join(' ')}\`)*\n\n3. Odczekaj około 10 sekund i kliknij poniższy przycisk:`);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('verify_check').setLabel('Sprawdź profil').setStyle(ButtonStyle.Success)
        );

        return interaction.editReply({ embeds: [embed], components: [row] });
      }

      if (interaction.customId === 'modal_id') {
        const fullName = interaction.fields.getTextInputValue('fullname');
        const birth = interaction.fields.getTextInputValue('birth');
        const citizen = interaction.fields.getTextInputValue('citizen');

        const userData = db.prepare('SELECT robloxId, robloxUsername FROM users WHERE discordId = ?').get(interaction.user.id);
        
        let avatarUrl = 'https://tr.rbxcdn.com/3943d4d7faad76e3d23f738a53e9a4f4/420/420/Image/Png';
        try {
          const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userData.robloxId}&size=420x420&format=Png&isCircular=false`);
          const thumbJson = await thumbRes.json();
          if (thumbJson.data && thumbJson.data[0]?.imageUrl) {
            avatarUrl = thumbJson.data[0].imageUrl;
          }
        } catch (e) {}

        const count = db.prepare('SELECT COUNT(*) as cnt FROM ids WHERE discordId = ?').get(interaction.user.id).cnt + 1;

        db.prepare('INSERT INTO ids (discordId, fullName, birthAndAge, citizenship, robloxAvatar, slotNumber) VALUES (?, ?, ?, ?, ?, ?)').run(
          interaction.user.id, fullName, birth, citizen, avatarUrl, count
        );

        const embed = new EmbedBuilder()
          .setColor(0x3498DB)
          .setTitle('🪪 OBYWATELSKI DOWÓD OSOBISTY')
          .setThumbnail(avatarUrl)
          .addFields(
            { name: '👤 Imię i Nazwisko', value: fullName, inline: false },
            { name: '🎂 Data Urodzenia i Wiek', value: birth, inline: true },
            { name: '🌍 Obywatelstwo', value: citizen, inline: true },
            { name: '🎮 Konto Roblox', value: `[${userData.robloxUsername}](https://www.roblox.com/users/${userData.robloxId}/profile)`, inline: false }
          )
          .setFooter({ text: `Postać ${count}/2 | Właściciel: ${interaction.user.tag}` })
          .setTimestamp();

        const targetCh = await client.channels.fetch(CH_DOWODY);
        await targetCh.send({ embeds: [embed] });

        return interaction.editReply({ content: `✅ Dowód tożsamości został pomyślnie wyrobiony (Postać ${count}/2)!` });
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
          .setTitle('🚗 ZAREJESTROWANO NOWY POJAZD')
          .addFields(
            { name: '🏷️ Marka Pojazdu', value: brand, inline: true },
            { name: '👤 Właściciel', value: owner, inline: true },
            { name: '🔢 Numer Rejestracyjny', value: `\`${plate.toUpperCase()}\``, inline: false }
          )
          .setFooter({ text: `Zarejestrowano przez: ${interaction.user.tag}` })
          .setTimestamp();

        const targetCh = await client.channels.fetch(CH_POJAZDY);
        await targetCh.send({ embeds: [embed] });

        return interaction.editReply({ content: '✅ Pojazd został pomyślnie zarejestrowany!' });
      }
    }
  } catch (err) {
    console.error('Błąd podczas obsługi interakcji:', err);
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: '❌ Wystąpił błąd podczas przetwarzania żądania.' }).catch(() => {});
    }
  }
});

client.login(TOKEN);
