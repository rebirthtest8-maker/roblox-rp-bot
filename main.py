import discord
from discord import app_commands
from discord.ext import commands
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
    conn.commit()
    cur.close()
    conn.close()

class MyBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=discord.Intents.all())
    async def setup_hook(self):
        init_db()
        await self.tree.sync()

bot = MyBot()

# --- KOMENDA /RP (START/END) ---
@bot.tree.command(name="rp", description="Zarządzaj sesją Roleplay")
@app_commands.choices(akcja=[
    app_commands.Choice(name="Start RP", value="start"),
    app_commands.Choice(name="End RP", value="end")
])
async def rp(interaction: discord.Interaction, akcja: str):
    if interaction.guild.get_role(ID_ROLA_RP) not in interaction.user.roles:
        return await interaction.response.send_message("❌ Nie masz uprawnień.", ephemeral=True)

    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("SELECT active FROM rp_state WHERE id = 1")
    is_active = cur.fetchone()[0]

    if akcja == "start":
        if is_active:
            cur.close(); conn.close()
            return await interaction.response.send_message("❌ Sesja RP już trwa!", ephemeral=True)
        cur.execute("UPDATE rp_state SET active = TRUE WHERE id = 1")
        embed = discord.Embed(title="🎭 START ROLEPLAY", description="Sesja RP rozpoczęta!", color=discord.Color.green())
        embed.set_image(url=GIF_START_RP)
        await interaction.guild.get_channel(ID_KANAL_RP).send(content="@everyone", embed=embed)
    else:
        if not is_active:
            cur.close(); conn.close()
            return await interaction.response.send_message("❌ Brak aktywnej sesji.", ephemeral=True)
        cur.execute("UPDATE rp_state SET active = FALSE WHERE id = 1")
        embed = discord.Embed(title="🛑 KONIEC ROLEPLAY", description="Sesja RP zakończona.", color=discord.Color.red())
        embed.set_image(url=GIF_END_RP)
        await interaction.guild.get_channel(ID_KANAL_RP).send(embed=embed)

    conn.commit(); cur.close(); conn.close()
    await interaction.response.send_message(f"✅ Wykonano: {akcja}", ephemeral=True)

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
# W komendzie /faktura:
async def faktura(interaction, komu: discord.Member, kwota: int, usluga: str):
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    cur = conn.cursor()
    # Odejmij od płacącego
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (komu.id,))
    cur.execute("UPDATE economy SET wallet = wallet - %s WHERE user_id = %s", (kwota, komu.id))
    # Dodaj wystawiającemu
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (interaction.user.id,))
    cur.execute("UPDATE economy SET wallet = wallet + %s WHERE user_id = %s", (kwota, interaction.user.id))
    conn.commit(); cur.close(); conn.close()
    await interaction.response.send_message(f"✅ Faktura na {kwota} ZŁ opłacona.")
    
    # Przelew w bazie ekonomii
    conn = get_db_conn(); cur = conn.cursor()
    cur.execute("INSERT INTO economy (user_id, wallet) VALUES (%s, 0) ON CONFLICT DO NOTHING", (komu.id,))
    cur.execute("UPDATE economy SET wallet = wallet - %s WHERE user_id = %s", (kwota, komu.id))
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

bot.run(os.getenv("DISCORD_TOKEN"))
