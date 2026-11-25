# Vigilancia NextDNS → Telegram

Cada 5 minutos revisa los perfiles de NextDNS configurados y manda un aviso a un grupo de Telegram cuando:

- 🚩 alguien intenta entrar en una web bloqueada por el control parental (porno, apuestas, citas, piratería, X/Reddit/Discord, VPN…);
- 🔌 un móvil lleva más de 45 min sin pasar por NextDNS (DNS quitado, móvil apagado o sin batería). Entre la 1 y las 7 de la mañana no avisa de esto;
- 🛠️ alguien cambia el filtro (quita una categoría, desactiva SafeSearch, apaga los registros, añade algo a la lista blanca);
- 🛡️ cada noche a las 22:00 manda un resumen. **Si un día no llega, alguien ha parado el vigilante.**

Los anuncios y rastreadores bloqueados no avisan.

## Puesta en marcha

### 1. Bot de Telegram (5 min)
1. En Telegram, habla con **@BotFather** → `/newbot` → ponle nombre (p. ej. `Vigilante`). Te da un **token**.
2. Opción A, por privado: cada persona abre el bot y pulsa *Iniciar*. Su id de usuario se puede ver con @userinfobot.
3. Opción B, grupo: crea un grupo con las personas y el bot, escribe algo, abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia el `"chat":{"id":-100…}`.

### 2. API keys de NextDNS
Cada cuenta tiene la suya, al final de https://my.nextdns.io/account (sección API).
Para la supervisión mutua, cada perfil está en la cuenta de la **otra** persona, así que cada perfil usa la API key de esa cuenta.

### 3. Repositorio en GitHub
1. El repo es **público** porque en los privados los minutos gratis de Actions no llegan para ejecutarlo cada 5 min. El código no contiene datos personales y la consola no imprime dominios ni nombres.
2. *Settings → Secrets and variables → Actions → New repository secret*:
   - `TELEGRAM_BOT_TOKEN`: el token del bot.
   - `TELEGRAM_CHAT_ID`: el id de un grupo, o varios ids de usuario separados por comas (`111,222`) para que el aviso llegue a cada uno por privado. Cada persona tiene que abrir el bot y pulsar *Iniciar* una vez.
   - `PROFILES_JSON`:
     ```json
     [
       {"name": "Persona A", "id": "ID_PERFIL_A", "apiKey": "API_KEY_DE_LA_CUENTA_DE_B", "device": "Movil-A"},
       {"name": "Persona B", "id": "ID_PERFIL_B", "apiKey": "API_KEY_DE_LA_CUENTA_DE_A", "device": "Movil-B"}
     ]
     ```
     Lo ideal es que **cada uno escriba su API key en privado**: los secretos de GitHub no se pueden volver a leer.
3. Pestaña *Actions → Vigilancia NextDNS → Run workflow* (con "test" marcado). Debería llegar un mensaje de prueba al grupo.

### 4. Nombre del dispositivo (recomendado)
Así el vigilante sabe cuál es el móvil aunque el perfil se use también en otro aparato. En *DNS privado* del móvil, poned el nombre delante del ID:
- `Movil-A-IDPERFIL.dns.nextdns.io`

Si no queréis complicaros, quitad `"device"` de `PROFILES_JSON` y se mirará todo el perfil.

## Ajustes opcionales
En *Settings → Secrets and variables → Actions → Variables*:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `INACTIVITY_MINUTES` | `45` | Minutos sin actividad antes de avisar |
| `QUIET_HOURS` | `01-07` | Franja sin avisos de inactividad |
| `DAILY_SUMMARY_HOUR` | `22` | Hora del resumen diario (`-1` lo desactiva) |

## Límites honestos
- Cualquiera puede quitar el DNS de su propio móvil. No se puede impedir, pero el otro se entera.
- El dueño del repo puede desactivar el workflow. Para eso está el resumen diario: si no llega, algo pasa.
- GitHub para los workflows programados de repos públicos tras 60 días sin commits, y avisa por email antes. Si pasa, basta con volver a activarlo.
- Un móvil que no usa datos (en modo avión, por ejemplo) también saltará como "sin NextDNS".
