import discord
from discord import app_commands
from discord.ext import commands, tasks
import os
import random
import psycopg2
from datetime import datetime, timedelta

# --- KONFIGURACJA ID ---
ID_ROLA_RP = 1505624602125013013
ID_KANAL_RP = 1505624605195370521
GIF_START_RP = "https://cdn.discordapp.com/attachments/1570060746237284486/1570862576810721280/standard_7.gif"
GIF_END_RP = "https://cdn.discordapp.com/attachments/1570841889463078945/1571442111314665562/standard_9.gif"

ID_KANAL_TRY = 1521465723887816796

ID_ROLA_WARN = 1505624602104172706
ID_KANAL_WARN_LOG = 1505624606831022157
ID_KANAL_BAN_LISTA = 1571443333992284170

ID_ROLA_FAKTURA = 1505624602062229805
ID_KANAL_FAKTURA = 1505624603949662288

ID_KANAL_PRACA = 1574822054010683423
ID_KANAL_LOG_PRACY = 1574821985857445949

# Frakcje i Zarząd
FACTION_ROLES = {
    1505624602083332096: "Sąd",
    1505624602083332097: "Pomoc drogowa",
    1505624602083332098: "Straż",
    1505624602083332099: "Ratownicy",
    1505624602083332100: "Policja"
}

MANAGEMENT_MAP = {
    1505624602095779860: (1505624602083332096, "Sąd"),
    1505624602083332105: (1505624602083332097, "Pomoc drogowa"),
    1505624602095779861: (1505624602083332098, "Straż"),
    1505624602095779862: (1505624602083332099, "Ratownicy"),
    1505624602095779863: (1505624602083332100, "Policja")
}

# --- BAZA DANYCH ---
def get_db_conn():
    return psycopg2.connect(os.getenv("DATABASE_URL"))

def init_db():
    conn = get_db_conn()
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS economy (user_id BIGINT PRIMARY KEY, wallet BIGINT DEFAULT 0)")
    cur.execute("CREATE TABLE IF NOT EXISTS rp_state (id INT PRIMARY KEY, active BOOLEAN)")
    cur.execute("INSERT INTO rp_state (id, active) VALUES (1, FALSE) ON CONFLICT DO NOTHING")
    cur.execute("CREATE TABLE IF NOT EXISTS user_warns (user_id BIGINT PRIMARY KEY, count INT DEFAULT 0)")
    cur.execute('''CREATE TABLE IF NOT EXISTS work_stats (
        user_id BIGINT, faction_id BIGINT, total_seconds INT DEFAULT 0, shifts_count INT DEFAULT 0,
        PRIMARY KEY (user_id, faction_id))''')
    cur.execute('''CREATE TABLE IF NOT EXISTS active_shifts (
        user_id BIGINT PRIMARY KEY, faction_id BIGINT, start_time TIMESTAMP, 
        total_seconds INT DEFAULT 0, is_break BOOLEAN DEFAULT FALSE)''')
    conn.commit()
    cur.close()
    conn.close()

def format_seconds(secs):
    h, remainder = divmod(secs, 3600)
    m, s = divmod(remainder, 60)
    return f"{h}h {m}m {s}s"

# --- SYSTEM PRACY (WIDOKI) ---
class WorkSelectView(discord.ui.View):
    def __init__(self, user, roles):
        super().__init__(timeout=120)
        self.user = user
        options = [discord.SelectOption(label=name, value=str(rid)) for rid, name in roles]
        self.add_item(WorkSelect(options))

class WorkSelect(discord.ui.Select):
    def __init__(self, options):
        super().__init__(placeholder="Wybierz frakcję...", options=options)
    async def callback(self, interaction: discord.Interaction):
        view = WorkPanelView(interaction.user, int(self.values[0]))
        await interaction.response.edit_message(content=f"Praca {interaction.user.mention}", embed=view.get_embed(), view=view)

class WorkPanelView(discord.ui.View):
    def __init__(self, user: discord.Member, faction_id: int):
        super().__init__(timeout=None)
        self.user = user
        self.faction_id = faction_id

    def get_embed(self):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT start_time, total_seconds, is_break FROM active_shifts WHERE user_id = %s", (self.user.id,))
        shift = cur.fetchone()
        cur.execute("SELECT total_seconds, shifts_count FROM work_stats WHERE user_id = %s AND faction_id = %s", (self.user.id, self.faction_id))
        stats = cur.fetchone()
        cur.close(); conn.close()

        status_text = "🔴 Służba nieaktywna"
        live_time = 0
        if shift:
            start_t, accum, is_paused = shift
            if is_paused:
                status_text = "🟡 Przerwa"
                live_time = accum
            else:
                status_text = "🟢 Służba aktywna"
                live_time = accum + int((datetime.now() - start_t).total_seconds())

        for child in self.children:
            if child.label == "Zacznij Pracę": child.disabled = (shift is not None and not shift[2])
            if child.label == "Przerwa w pracy": child.disabled = (shift is None or shift[2])
            if child.label == "Zakończ Pracę": child.disabled = (shift is None)

        total_week = (stats[0] if stats else 0) + live_time
        shifts = stats[1] if stats else 0
        avg = int(total_week / shifts) if shifts > 0 else 0

        embed = discord.Embed(title="🛣️ REJESTRATOR PRACY", color=discord.Color.blue())
        embed.add_field(name="📌 Aktualny Status", value=f"```\n{status_text}\n```", inline=False)
        embed.add_field(name="📊 Statystyki Bieżącego Tygodnia", value=f"Zrealizowane Shifty: {shifts}\nCzas tygodniowy: {format_seconds(total_week)}\nŚredni czas służby: {format_seconds(avg)}", inline=False)
        embed.set_footer(text=f"System liczenia Pracy • {datetime.now().strftime('%d.%m.%Y %H:%M')}")
        return embed

    @discord.ui.button(label="Zacznij Pracę", style=discord.ButtonStyle.success)
    async def start(self, interaction: discord.Interaction, b: discord.ui.Button):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("INSERT INTO active_shifts (user_id, faction_id, start_time) VALUES (%s, %s, %s) ON CONFLICT (user_id) DO UPDATE SET is_break = FALSE, start_time = %s", (self.user.id, self.faction_id, datetime.now(), datetime.now()))
        conn.commit(); cur.close(); conn.close()
        await interaction.response.edit_message(embed=self.get_embed(), view=self)

    @discord.ui.button(label="Przerwa w pracy", style=discord.ButtonStyle.secondary)
    async def pause(self, interaction: discord.Interaction, b: discord.ui.Button):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT start_time FROM active_shifts WHERE user_id = %s", (self.user.id,))
        start_t = cur.fetchone()[0]
        elapsed = int((datetime.now() - start_t).total_seconds())
        cur.execute("UPDATE active_shifts SET is_break = TRUE, total_seconds = total_seconds + %s WHERE user_id = %s", (elapsed, self.user.id))
        conn.commit(); cur.close(); conn.close()
        await interaction.response.edit_message(embed=self.get_embed(), view=self)

    @discord.ui.button(label="Zakończ Pracę", style=discord.ButtonStyle.danger)
    async def end(self, interaction: discord.Interaction, b: discord.ui.Button):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT faction_id, start_time, total_seconds, is_break FROM active_shifts WHERE user_id = %s", (self.user.id,))
        fid, st, total, br = cur.fetchone()
        final_elapsed = total + (int((datetime.now() - st).total_seconds()) if not br else 0)
        cur.execute("DELETE FROM active_shifts WHERE user_id = %s", (self.user.id,))
        cur.execute("INSERT INTO work_stats (user_id, faction_id, total_seconds, shifts_count) VALUES (%s, %s, %s, 1) ON CONFLICT (user_id, faction_id) DO UPDATE SET total_seconds = work_stats.total_seconds + %s, shifts_count = work_stats.shifts_count + 1", (self.user.id, fid, final_elapsed, final_elapsed))
        conn.commit(); cur.close(); conn.close()
        
        log = interaction.guild.get_channel(ID_KANAL_LOG_PRACY)
        if log:
            emb = discord.Embed(title="🏁 KONIEC SŁUŻBY", color=discord.Color.red(), timestamp=datetime.now())
            emb.add_field(name="Pracownik", value=self.user.mention); emb.add_field(name="Frakcja", value=FACTION_ROLES.get(fid))
            emb.add_field(name="Czas shiftu", value=format_seconds(final_elapsed), inline=False)
            await log.send(embed=emb)
        await interaction.response.edit_message(embed=self.get_embed(), view=self)

# --- KLASA BOTA ---
class MyBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=discord.Intents.all())

    async def setup_hook(self):
        init_db()
        await self.tree.sync()
        self.weekly_report.start()

    @tasks.loop(minutes=1)
    async def weekly_report(self):
        now = datetime.now()
        # Poniedziałek, 16:30
        if now.weekday() == 0 and now.hour == 16 and now.minute == 30:
            channel = self.get_channel(ID_KANAL_LOG_PRACY)
            if not channel: return
            conn = get_db_conn(); cur = conn.cursor()
            embed = discord.Embed(title="📊 PODSUMOWANIE TYGODNIOWE", color=discord.Color.gold(), timestamp=datetime.now())
            for fid, name in FACTION_ROLES.items():
                cur.execute("SELECT user_id, total_seconds FROM work_stats WHERE faction_id = %s ORDER BY total_seconds DESC LIMIT 3", (fid,))
                rows = cur.fetchall()
                val = "\n".join([f"{i+1}. <@{r[0]}> - {format_seconds(r[1])}" for i, r in enumerate(rows)]) or "Brak danych."
                embed.add_field(name=f"📋 {name}", value=val, inline=False)
            cur.execute("DELETE FROM work_stats")
            conn.commit(); cur.close(); conn.close()
            await channel.send(embed=embed)

bot = MyBot()

# --- KOMENDY ZE ZDJĘCIA ---

@bot.tree.command(name="faktura", description="Wystaw fakturę")
async def faktura(interaction: discord.Interaction, komu: discord.Member, kwota: int, usluga: str):
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (komu.id,))
    cur.execute("UPDATE economy SET wallet = wallet - %s WHERE user_id = %s", (kwota, komu.id))
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (interaction.user.id,))
    cur.execute("UPDATE economy SET wallet = wallet + %s WHERE user_id = %s", (kwota, interaction.user.id))
    conn.commit(); cur.close(); conn.close()
    
    embed = discord.Embed(title="🧾 NOWA FAKTURA", color=discord.Color.blue(), timestamp=datetime.now())
    embed.add_field(name="Wystawiający", value=interaction.user.mention); embed.add_field(name="Otrzymujący", value=komu.mention)
    embed.add_field(name="Kwota", value=f"**{kwota} ZŁ**", inline=False); embed.add_field(name="Usługa", value=f"```{usluga}```", inline=False)
    await interaction.guild.get_channel(ID_KANAL_FAKTURA).send(content=komu.mention, embed=embed)
    await interaction.response.send_message("✅ Faktura opłacona.", ephemeral=True)

@bot.tree.command(name="pracuj", description="Rozpocznij lub zarządzaj czasem pracy")
async def pracuj(interaction: discord.Interaction):
    if interaction.channel_id != ID_KANAL_PRACA:
        return await interaction.response.send_message(f"❌ Użyj kanału <#{ID_KANAL_PRACA}>", ephemeral=True)
    roles = [(rid, name) for rid, name in FACTION_ROLES.items() if interaction.guild.get_role(rid) in interaction.user.roles]
    if not roles: return await interaction.response.send_message("❌ Nie należysz do żadnej frakcji.", ephemeral=True)
    
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("SELECT faction_id FROM active_shifts WHERE user_id = %s", (interaction.user.id,))
    row = cur.fetchone(); cur.close(); conn.close()
    
    if row:
        view = WorkPanelView(interaction.user, row[0])
        await interaction.response.send_message(embed=view.get_embed(), view=view)
    else:
        if len(roles) == 1:
            view = WorkPanelView(interaction.user, roles[0][0])
            await interaction.response.send_message(embed=view.get_embed(), view=view)
        else:
            await interaction.response.send_message("Wybierz frakcję:", view=WorkSelectView(interaction.user, roles), ephemeral=True)

@bot.tree.command(name="rp", description="Zarządzaj sesją Roleplay")
@app_commands.choices(akcja=[app_commands.Choice(name="Start RP", value="start"), app_commands.Choice(name="End RP", value="end")])
async def rp(interaction: discord.Interaction, akcja: str):
    if interaction.guild.get_role(ID_ROLA_RP) not in interaction.user.roles:
        return await interaction.response.send_message("❌ Brak uprawnień.", ephemeral=True)
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("UPDATE rp_state SET active = %s WHERE id = 1", (akcja == "start",))
    conn.commit(); cur.close(); conn.close()
    embed = discord.Embed(title=f"{'🎭 START' if akcja=='start' else '🛑 KONIEC'} ROLEPLAY", color=discord.Color.green() if akcja=="start" else discord.Color.red())
    embed.set_image(url=GIF_START_RP if akcja=="start" else GIF_END_RP)
    await interaction.guild.get_channel(ID_KANAL_RP).send(content="@everyone" if akcja=="start" else "", embed=embed)
    await interaction.response.send_message(f"✅ Wykonano: {akcja}", ephemeral=True)

@bot.tree.command(name="sprawdz", description="Sprawdź czas pracy obywatela")
async def sprawdz(interaction: discord.Interaction, osoba: discord.Member):
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("SELECT faction_id, total_seconds FROM work_stats WHERE user_id = %s", (osoba.id,))
    data = cur.fetchall(); cur.close(); conn.close()
    embed = discord.Embed(title=f"⏱️ Czas służby: {osoba.display_name}", color=discord.Color.blue())
    found = False
    for rid, name in FACTION_ROLES.items():
        if interaction.guild.get_role(rid) in osoba.roles:
            sec = next((r[1] for r in data if r[0] == rid), 0)
            embed.add_field(name=name, value=format_seconds(sec), inline=False)
            found = True
    if not found: return await interaction.response.send_message("❌ Ten obywatel nie jest w żadnej frakcji.", ephemeral=True)
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="try", description="Wykonaj akcję losową /try")
async def try_cmd(interaction: discord.Interaction, wiadomosc: str):
    res = random.choice(["UDANE", "NIEUDANE"])
    embed = discord.Embed(title=f"🎲 Próba: {res}", description=f"{interaction.user.mention} {wiadomosc}", color=discord.Color.green() if res=="UDANE" else discord.Color.red())
    await interaction.response.send_message(content=interaction.user.mention, embed=embed)

@bot.tree.command(name="warn", description="Nadaj warn użytkownikowi")
async def warn(interaction: discord.Interaction, osoba: discord.Member):
    if interaction.guild.get_role(ID_ROLA_WARN) not in interaction.user.roles:
        return await interaction.response.send_message("❌ Brak uprawnień.", ephemeral=True)
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("INSERT INTO user_warns (user_id, count) VALUES (%s, 1) ON CONFLICT (user_id) DO UPDATE SET count = user_warns.count + 1 RETURNING count", (osoba.id,))
    count = cur.fetchone()[0]; conn.commit(); cur.close(); conn.close()
    if count >= 4: await interaction.guild.get_channel(ID_KANAL_BAN_LISTA).send(f"🚨 {osoba.mention} osiągnął 4 warny!")
    embed = discord.Embed(title="⚠️ WARN", description=f"Ukarany: {osoba.mention}\nStatus: {count}/4", color=discord.Color.orange())
    await interaction.guild.get_channel(ID_KANAL_WARN_LOG).send(embed=embed)
    await interaction.response.send_message(f"✅ Nadano warna {osoba.display_name}.", ephemeral=True)

@bot.tree.command(name="zarzadzaj-czasem", description="Zarządzaj czasem swoich pracowników")
@app_commands.choices(akcja=[app_commands.Choice(name="Dodaj", value="add"), app_commands.Choice(name="Odejmij", value="sub")])
async def zarzadzaj_czasem(interaction: discord.Interaction, akcja: str, osoba: discord.Member, sekundy: int):
    manager_faction = next((v[0] for k, v in MANAGEMENT_MAP.items() if interaction.guild.get_role(k) in interaction.user.roles), None)
    if not manager_faction: return await interaction.response.send_message("❌ Nie jesteś w zarządzie.", ephemeral=True)
    if interaction.guild.get_role(manager_faction) not in osoba.roles: return await interaction.response.send_message("❌ Ten pracownik nie jest z Twojej frakcji.", ephemeral=True)
    
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("INSERT INTO work_stats (user_id, faction_id, total_seconds) VALUES (%s, %s, 0) ON CONFLICT DO NOTHING", (osoba.id, manager_faction))
    cur.execute(f"UPDATE work_stats SET total_seconds = GREATEST(0, total_seconds {'+' if akcja=='add' else '-'} %s) WHERE user_id = %s AND faction_id = %s", (sekundy, osoba.id, manager_faction))
    conn.commit(); cur.close(); conn.close()
    await interaction.response.send_message(f"✅ Zaktualizowano czas {osoba.display_name} o {sekundy}s.", ephemeral=True)

@bot.command()
@commands.is_owner()
async def sync(ctx):
    await bot.tree.sync()
    await ctx.send("✅ Zsynchronizowano komendy!")

bot.run(os.getenv("DISCORD_TOKEN"))
