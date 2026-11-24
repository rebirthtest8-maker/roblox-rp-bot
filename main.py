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

# Lista ID uprawnionych do ogłoszeń
ID_WLASCICIEL_OGLOS = [1130375423247790162, 1384107274754199573]

# --- BAZA DANYCH ---
def get_db_conn():
    return psycopg2.connect(os.getenv("DATABASE_URL"))

def init_db():
    conn = get_db_conn()
    cur = conn.cursor()
    # Wspólna tabela ekonomii
    cur.execute('''CREATE TABLE IF NOT EXISTS economy (
        user_id BIGINT PRIMARY KEY,
        wallet BIGINT DEFAULT 0,
        last_collect TIMESTAMP,
        last_work TIMESTAMP
    )''')
    cur.execute("CREATE TABLE IF NOT EXISTS rp_state (id INT PRIMARY KEY, active BOOLEAN)")
    cur.execute("INSERT INTO rp_state (id, active) VALUES (1, FALSE) ON CONFLICT DO NOTHING")
    cur.execute("CREATE TABLE IF NOT EXISTS user_warns (user_id BIGINT PRIMARY KEY, count INT DEFAULT 0)")
    
    # Tabele czasu pracy
    cur.execute('''CREATE TABLE IF NOT EXISTS work_stats (
        user_id BIGINT,
        faction_id BIGINT,
        total_seconds INT DEFAULT 0,
        shifts_count INT DEFAULT 0,
        PRIMARY KEY (user_id, faction_id)
    )''')
    cur.execute('''CREATE TABLE IF NOT EXISTS active_shifts (
        user_id BIGINT PRIMARY KEY,
        faction_id BIGINT,
        start_time TIMESTAMP,
        total_seconds INT DEFAULT 0,
        is_break BOOLEAN DEFAULT FALSE,
        break_start TIMESTAMP
    )''')
    conn.commit()
    cur.close()
    conn.close()

def format_seconds(secs):
    hours, remainder = divmod(secs, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}h {minutes}m {seconds}s"

# --- SYSTEM WIDOKÓW DLA REJESTRATORA PRACY ---
class WorkSelectView(discord.ui.View):
    def __init__(self, user: discord.Member, roles_to_show: list):
        super().__init__(timeout=120)
        self.user = user
        options = [discord.SelectOption(label=name, value=str(r_id)) for r_id, name in roles_to_show]
        self.add_item(WorkSelect(options))

class WorkSelect(discord.ui.Select):
    def __init__(self, options):
        super().__init__(placeholder="Wybierz Frakcję do pracy...", options=options)
        
    async def callback(self, interaction: discord.Interaction):
        faction_id = int(self.values[0])
        view = WorkPanelView(interaction.user, faction_id)
        embed = view.get_embed()
        await interaction.response.edit_message(content=f"Praca {interaction.user.mention}", embed=embed, view=view)

class WorkPanelView(discord.ui.View):
    def __init__(self, user: discord.Member, faction_id: int):
        super().__init__(timeout=None)
        self.user = user
        self.faction_id = faction_id

    def get_embed(self):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT * FROM active_shifts WHERE user_id = %s", (self.user.id,))
        shift_row = cur.fetchone()
        
        cur.execute("SELECT total_seconds, shifts_count FROM work_stats WHERE user_id = %s AND faction_id = %s", (self.user.id, self.faction_id))
        stats_row = cur.fetchone()
        cur.close(); conn.close()

        status_text = "🔴 Służba nieaktywna"
        if shift_row:
            if shift_row[4]:  # is_break
                status_text = "🟡 Przerwa"
            else:
                status_text = "🟢 Służba aktywna"

        shifts_count = stats_row[1] if stats_row else 0
        total_time_sec = stats_row[0] if stats_row else 0
        avg_time_sec = int(total_time_sec / shifts_count) if shifts_count > 0 else 0

        embed = discord.Embed(title="🛣️ REJESTRATOR PRACY", color=discord.Color.blue())
        embed.add_field(name="📌 Aktualny Status", value=f"```\n{status_text}\n```", inline=False)
        embed.add_field(name="📊 Statystyki Bieżącego Tygodnia", value=(
            f"Zrealizowane Shifty: {shifts_count}\n"
            f"Czas tygodniowy: {format_seconds(total_time_sec)}\n"
            f"Średni czas służby: {format_seconds(avg_time_sec)}"
        ), inline=False)
        embed.set_footer(text=f"System liczenia Pracy • {datetime.now().strftime('%d.%m.%Y %H:%M')}")
        return embed

    @discord.ui.button(label="Zacznij Pracę", style=discord.ButtonStyle.success)
    async def start_work(self, interaction: discord.Interaction, button: discord.ui.Button):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT * FROM active_shifts WHERE user_id = %s", (interaction.user.id,))
        row = cur.fetchone()
        now = datetime.now()

        if not row:
            cur.execute("INSERT INTO active_shifts (user_id, faction_id, start_time) VALUES (%s, %s, %s)",
                        (interaction.user.id, self.faction_id, now))
            await interaction.response.send_message("🟢 Rozpocząłeś służbę!", ephemeral=True)
        else:
            is_break = row[4]
            if is_break:
                cur.execute("UPDATE active_shifts SET is_break = FALSE, start_time = %s WHERE user_id = %s", (now, interaction.user.id))
                await interaction.response.send_message("🟢 Wznowiłeś służbę z przerwy!", ephemeral=True)
            else:
                await interaction.response.send_message("❌ Twoja służba jest już aktywna!", ephemeral=True)

        conn.commit(); cur.close(); conn.close()
        await interaction.message.edit(embed=self.get_embed(), view=self)

    @discord.ui.button(label="Przerwa w pracy", style=discord.ButtonStyle.secondary)
    async def break_work(self, interaction: discord.Interaction, button: discord.ui.Button):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT * FROM active_shifts WHERE user_id = %s", (interaction.user.id,))
        row = cur.fetchone()
        now = datetime.now()

        if not row:
            await interaction.response.send_message("❌ Nie masz rozpoczętej służby!", ephemeral=True)
        else:
            _, _, start_time, total_seconds, is_break, _ = row
            if is_break:
                await interaction.response.send_message("❌ Jesteś już na przerwie!", ephemeral=True)
            else:
                elapsed = int((now - start_time).total_seconds())
                new_total = total_seconds + elapsed
                cur.execute("UPDATE active_shifts SET is_break = TRUE, break_start = %s, total_seconds = %s WHERE user_id = %s",
                            (now, new_total, interaction.user.id))
                await interaction.response.send_message("🟡 Rozpocząłeś przerwę.", ephemeral=True)

        conn.commit(); cur.close(); conn.close()
        await interaction.message.edit(embed=self.get_embed(), view=self)

    @discord.ui.button(label="Zakończ Pracę", style=discord.ButtonStyle.danger)
    async def end_work(self, interaction: discord.Interaction, button: discord.ui.Button):
        conn = get_db_conn(); cur = conn.cursor()
        cur.execute("SELECT * FROM active_shifts WHERE user_id = %s", (interaction.user.id,))
        row = cur.fetchone()
        now = datetime.now()

        if not row:
            await interaction.response.send_message("❌ Nie masz aktywnej służby!", ephemeral=True)
            cur.close(); conn.close()
            return

        _, faction_id, start_time, total_seconds, is_break, _ = row
        shift_secs = total_seconds
        if not is_break:
            shift_secs += int((now - start_time).total_seconds())

        cur.execute("DELETE FROM active_shifts WHERE user_id = %s", (interaction.user.id,))
        cur.execute('''INSERT INTO work_stats (user_id, faction_id, total_seconds, shifts_count)
                       VALUES (%s, %s, %s, 1)
                       ON CONFLICT (user_id, faction_id)
                       DO UPDATE SET total_seconds = work_stats.total_seconds + %s, shifts_count = work_stats.shifts_count + 1''',
                    (interaction.user.id, faction_id, shift_secs, shift_secs))
        conn.commit(); cur.close(); conn.close()

        log_channel = interaction.guild.get_channel(1574821985857445949)
        if log_channel:
            fact_name = FACTION_ROLES.get(faction_id, "Nieznana")
            emb = discord.Embed(title="🏁 SŁUŻBA ZAKOŃCZONA", color=discord.Color.red(), timestamp=datetime.now())
            emb.add_field(name="Pracownik", value=interaction.user.mention, inline=True)
            emb.add_field(name="Frakcja", value=fact_name, inline=True)
            emb.add_field(name="Czas", value=format_seconds(shift_secs), inline=False)
            await log_channel.send(embed=emb)

        await interaction.response.send_message(f"✅ Służba zakończona! Przepracowano: {format_seconds(shift_secs)}", ephemeral=True)
        await interaction.message.edit(embed=self.get_embed(), view=self)

class MyBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=discord.Intents.all())
    async def setup_hook(self):
        init_db()
        await self.tree.sync()
        self.weekly_work_report.start()

    @tasks.loop(minutes=1)
    async def weekly_work_report(self):
        now = datetime.now()
        if now.weekday() == 0 and now.hour == 16 and now.minute == 30:
            channel = self.get_channel(1574821985857445949)
            if not channel:
                return
            
            conn = get_db_conn(); cur = conn.cursor()
            embed = discord.Embed(title="📊 PODSUMOWANIE TYGODNIOWE", color=discord.Color.gold(), timestamp=datetime.now())
            
            for f_id, f_name in FACTION_ROLES.items():
                cur.execute("SELECT user_id, total_seconds FROM work_stats WHERE faction_id = %s ORDER BY total_seconds DESC LIMIT 3", (f_id,))
                rows = cur.fetchall()
                txt = ""
                for idx, (uid, secs) in enumerate(rows, 1):
                    txt += f"{idx}. <@{uid}> - {format_seconds(secs)}\n"
                if not txt:
                    txt = "Brak aktywności."
                embed.add_field(name=f_name, value=txt, inline=False)
                
            cur.execute("DELETE FROM work_stats")
            conn.commit(); cur.close(); conn.close()
            await channel.send(embed=embed)

bot = MyBot()

# --- KOMENDA !SYNC (MANUALNA SYNCHRONIZACJA KOMEND) ---
@bot.command()
@commands.is_owner()
async def sync(ctx):
    await bot.tree.sync()
    await ctx.send("✅ Zsynchronizowano komendy ukośnika globally!")

# --- KOMENDA /RP (START/END) ---
@bot.tree.command(name="rp", description="Zarządzaj sesją Roleplay")
@app_commands.choices(akcja=[
    app_commands.Choice(name="Start RP", value="start"),
    app_commands.Choice(name="End RP", value="end")
])
async def rp(interaction: discord.Interaction, akcja: str):
    if interaction.guild.get_role(ID_ROLA_RP) not in interaction.user.roles:
        return await interaction.response.send_message("❌ Nie masz uprawnień.", ephemeral=True)

    await interaction.response.defer(ephemeral=True)

    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("SELECT active FROM rp_state WHERE id = 1")
    is_active = cur.fetchone()[0]

    if akcja == "start":
        if is_active:
            cur.close(); conn.close()
            return await interaction.followup.send("❌ Sesja RP już trwa!")
        cur.execute("UPDATE rp_state SET active = TRUE WHERE id = 1")
        embed = discord.Embed(title="🎭 START ROLEPLAY", description="Sesja RP rozpoczęta!", color=discord.Color.green())
        embed.set_image(url=GIF_START_RP)
        await interaction.guild.get_channel(ID_KANAL_RP).send(content="@everyone", embed=embed)
    else:
        if not is_active:
            cur.close(); conn.close()
            return await interaction.followup.send("❌ Brak aktywnej sesji.")
        cur.execute("UPDATE rp_state SET active = FALSE WHERE id = 1")
        embed = discord.Embed(title="🛑 KONIEC ROLEPLAY", description="Sesja RP zakończona.", color=discord.Color.red())
        embed.set_image(url=GIF_END_RP)
        await interaction.guild.get_channel(ID_KANAL_RP).send(embed=embed)

    conn.commit(); cur.close(); conn.close()
    await interaction.followup.send(f"✅ Wykonano: {akcja}")

# --- KOMENDA /TRY ---
@bot.tree.command(name="try", description="Wykonaj akcję losową /try")
async def try_cmd(interaction: discord.Interaction, wiadomosc: str):
    if interaction.channel_id != ID_KANAL_TRY:
        return await interaction.response.send_message("❌ Zły kanał.", ephemeral=True)
    wynik = random.choice(["UDANE", "NIEUDANE"])
    kolor = discord.Color.green() if wynik == "UDANE" else discord.Color.red()
    embed = discord.Embed(title=f"🎲 Próba: {wynik}", description=f"{interaction.user.mention} {wiadomosc}", color=kolor)
    await interaction.response.send_message(content=interaction.user.mention, embed=embed)

# --- KOMENDA /WARN ---
@bot.tree.command(name="warn", description="Nadaj warn użytkownikowi")
async def warn(interaction: discord.Interaction, osoba: discord.Member):
    if interaction.guild.get_role(ID_ROLA_WARN) not in interaction.user.roles:
        return await interaction.response.send_message("❌ Nie masz uprawnień.", ephemeral=True)

    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("INSERT INTO user_warns (user_id, count) VALUES (%s, 1) ON CONFLICT (user_id) DO UPDATE SET count = user_warns.count + 1 RETURNING count", (osoba.id,))
    warn_count = cur.fetchone()[0]
    
    if warn_count >= 4:
        ban_chan = interaction.guild.get_channel(ID_KANAL_BAN_LISTA)
        await ban_chan.send(f"🚨 Użytkownik {osoba.mention} ma **4 warny**. Oczekuje na bana 24h.")
        cur.execute("UPDATE user_warns SET count = 0 WHERE user_id = %s", (osoba.id,))

    embed = discord.Embed(title="⚠️ NADANO OSTRZEŻENIE", color=discord.Color.orange())
    embed.add_field(name="Ukarany", value=osoba.mention, inline=True)
    embed.add_field(name="Status", value=f"Warny: {warn_count}/4", inline=False)
    await interaction.guild.get_channel(ID_KANAL_WARN_LOG).send(embed=embed)
    conn.commit(); cur.close(); conn.close()
    await interaction.response.send_message("✅ Nadano warna.", ephemeral=True)

# --- KOMENDA /FAKTURA ---
@bot.tree.command(name="faktura", description="Wystaw fakturę")
async def faktura(interaction: discord.Interaction, komu: discord.Member, kwota: int, usluga: str):
    conn = get_db_conn(); cur = conn.cursor()
    # Odejmij od płacącego
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (komu.id,))
    cur.execute("UPDATE economy SET wallet = wallet - %s WHERE user_id = %s", (kwota, komu.id))
    # Dodaj wystawiającemu
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (interaction.user.id,))
    cur.execute("UPDATE economy SET wallet = wallet + %s WHERE user_id = %s", (kwota, interaction.user.id))
    conn.commit(); cur.close(); conn.close()

    embed = discord.Embed(title="🧾 NOWA FAKTURA", color=discord.Color.blue(), timestamp=datetime.now())
    embed.add_field(name="Wystawiający", value=interaction.user.mention, inline=True)
    embed.add_field(name="Otrzymujący", value=komu.mention, inline=True)
    embed.add_field(name="Kwota", value=f"**{kwota} ZŁ**", inline=False)
    embed.add_field(name="Usługa", value=f"```{usluga}```", inline=False)
    
    await interaction.guild.get_channel(ID_KANAL_FAKTURA).send(content=komu.mention, embed=embed)
    await interaction.response.send_message("✅ Faktura wystawiona i opłacona.", ephemeral=True)

# --- KOMENDA /PRACUJ ---
@bot.tree.command(name="pracuj", description="Rozpocznij lub zarządzaj czasem pracy")
async def pracuj(interaction: discord.Interaction):
    if interaction.channel_id != 1574822054010683423:
        return await interaction.response.send_message("❌ Tej komendy możesz używać tylko na kanale <#1574822054010683423>.", ephemeral=True)

    roles_held = []
    for r_id, f_name in FACTION_ROLES.items():
        if interaction.guild.get_role(r_id) in interaction.user.roles:
            roles_held.append((r_id, f_name))

    if not roles_held:
        return await interaction.response.send_message("❌ Nie posiadasz rangi uprawniającej do rejestracji pracy.", ephemeral=True)

    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("SELECT faction_id FROM active_shifts WHERE user_id = %s", (interaction.user.id,))
    row = cur.fetchone()
    cur.close(); conn.close()

    if row:
        view = WorkPanelView(interaction.user, row[0])
        await interaction.response.send_message(content=f"Praca {interaction.user.mention}", embed=view.get_embed(), view=view)
    else:
        if len(roles_held) == 1:
            view = WorkPanelView(interaction.user, roles_held[0][0])
            await interaction.response.send_message(content=f"Praca {interaction.user.mention}", embed=view.get_embed(), view=view)
        else:
            view = WorkSelectView(interaction.user, roles_held)
            await interaction.response.send_message("Wybierz pracę:", view=view, ephemeral=True)

# --- KOMENDA /ZARZĄDZAJ-CZASEM ---
@bot.tree.command(name="zarzadzaj-czasem", description="Zarządzaj czasem swoich pracowników")
@app_commands.choices(akcja=[
    app_commands.Choice(name="Dodaj czas", value="add"),
    app_commands.Choice(name="Odejmij Czas", value="sub")
])
async def zarzadzaj_czasem(interaction: discord.Interaction, akcja: str, osoba: discord.Member, czas_minuty: int):
    faction_to_manage = []
    for m_role, (f_role, f_name) in MANAGEMENT_MAP.items():
        if interaction.guild.get_role(m_role) in interaction.user.roles:
            faction_to_manage.append((f_role, f_name))

    if not faction_to_manage:
        return await interaction.response.send_message("❌ Nie masz rangi zarządu, aby zarządzać czasem.", ephemeral=True)

    managed_role = None
    managed_name = None
    for f_role, f_name in faction_to_manage:
        if interaction.guild.get_role(f_role) in osoba.roles:
            managed_role = f_role
            managed_name = f_name
            break

    if not managed_role:
        return await interaction.response.send_message("❌ Ta osoba nie należy do frakcji, którą możesz zarządzać.", ephemeral=True)

    secs = czas_minuty * 60
    conn = get_db_conn(); cur = conn.cursor()
    
    cur.execute("INSERT INTO work_stats (user_id, faction_id, total_seconds, shifts_count) VALUES (%s, %s, 0, 0) ON CONFLICT DO NOTHING", (osoba.id, managed_role))
    
    if akcja == "add":
        cur.execute("UPDATE work_stats SET total_seconds = total_seconds + %s WHERE user_id = %s AND faction_id = %s", (secs, osoba.id, managed_role))
        msg = f"✅ Dodano {czas_minuty} minut(y) do czasu {osoba.mention} we frakcji {managed_name}."
    else:
        cur.execute("SELECT total_seconds FROM work_stats WHERE user_id = %s AND faction_id = %s", (osoba.id, managed_role))
        curr_secs = cur.fetchone()[0]
        if curr_secs < secs:
            cur.close(); conn.close()
            return await interaction.response.send_message("❌ Nie można odjąć czasu na wartość ujemną!", ephemeral=True)
        cur.execute("UPDATE work_stats SET total_seconds = total_seconds - %s WHERE user_id = %s AND faction_id = %s", (secs, osoba.id, managed_role))
        msg = f"✅ Odjęto {czas_minuty} minut(y) z czasu {osoba.mention} we frakcji {managed_name}."

    conn.commit(); cur.close(); conn.close()
    await interaction.response.send_message(msg)

# --- KOMENDA /SPRAWDZ ---
@bot.tree.command(name="sprawdz", description="Sprawdź czas pracy obywatela")
async def sprawdz(interaction: discord.Interaction, osoba: discord.Member):
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("SELECT faction_id, total_seconds FROM work_stats WHERE user_id = %s", (osoba.id,))
    rows = cur.fetchall()
    cur.close(); conn.close()

    embed = discord.Embed(title=f"⏱️ Czas służby: {osoba.display_name}", color=discord.Color.blue())
    has_stats = False

    for f_id, f_name in FACTION_ROLES.items():
        if interaction.guild.get_role(f_id) in osoba.roles:
            secs = 0
            for row_fid, row_sec in rows:
                if row_fid == f_id:
                    secs = row_sec
                    break
            embed.add_field(name=f_name, value=format_seconds(secs), inline=False)
            has_stats = True

    if not has_stats:
        return await interaction.response.send_message("❌ Ta osoba nie jest przypisana do żadnej frakcji.", ephemeral=True)

    await interaction.response.send_message(embed=embed)

@bot.event
async def on_ready():
    await bot.change_presence(status=discord.Status.online, activity=discord.CustomActivity(name="Gram na Vesper RP"))
    print(f"✅ Bot Synek online as {bot.user}")

bot.run(os.getenv("DISCORD_TOKEN"))
