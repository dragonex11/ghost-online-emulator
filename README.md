# Ghost Online Private Server

Ghost Online emulator for the Malaysian client. This is an experimental project for educational purposes — use at your own risk.

![In-game screenshot](docs/ingame-screenshot.png)

## What's working

**Working**
- ✅ Auth / auto-register
- ✅ Character select / create / delete
- ✅ Maps, movement, combat
- ✅ Drops, shops, cash shop
- ✅ Quests, fishing
- ✅ Merchant shops (free market)
- ✅ Friend list, party, mail
- ✅ Monster AI / respawn / aggro

**Not working**
- ❌ Guild
- ❌ Alliance
- ❌ Chat room
- ❌ PVP
- ❌ Better mob system
- ❌ PQS
- ❌ More…

## Architecture

The process opens several sockets the game client talks to in sequence:

| Server | Protocol | Port | Role |
|--------|----------|------|------|
| Login | TCP | 15001 | Account login |
| Channel | TCP | 15013 | Character select |
| Field | TCP | 15023 | In-game world |
| Field | UDP | 13997 | In-game world (UDP) |
| Messenger | TCP | 17201 (alt 13070) | Social / messaging |

## Requirements

- Node.js 20+
- MySQL 5.7+ / 8.x or MariaDB

## Quick start

```bash
cp .env.example .env
# edit .env → set DATABASE_URL

mysql -u USER -p -e "CREATE DATABASE IF NOT EXISTS ghostonline CHARACTER SET latin1;"
mysql -u USER -p ghostonline < database/schema.sql

npm install
npm start
```

`database/schema.sql` is the **only** database file you need. It creates all tables and seeds:

- GM account
- Monster spawns
- Cash shop catalog
- Monster drop rules
- NPC item prices

### Default GM account

| Field | Value |
|-------|--------|
| Username | `admin` |
| Password | `admin` |
| GM | yes |

Create a character in-game after logging in.

## GM commands

GM accounts (`gm > 0` in the database) can run commands in-game chat. Every command must start with `//` followed by a letter (e.g. `//heal`, not bare `//`).

| Command | Description |
|---------|-------------|
| `//notice <text>` or `//1 <text>` | Broadcast a server notice to all online players |
| `//heal` | Restore HP and MP to maximum |
| `//hp [value]` | Set HP and max HP to `value` (1–32767). No argument = full heal |
| `//mp [value]` | Set MP and max MP to `value` (1–32767). No argument = full restore |
| `//money [amount]` | Add gold (default `10000`) |
| `//level <1-99>` | Set character level |
| `//levelup` | Increase level by 1 |
| `//warp <map> <region> [x] [y]` | Warp to map coordinates (defaults: map `1`, region `1`, x/y `100`) |
| `//gogo <map> <region>` | Warp to map/region and keep current X/Y |
| `//warp <playerName>` | Warp to an online player by name |
| `//job <0-3>` | Set 1st job (`0` beginner, `1` warrior, `2` assassin, `3` mage). Clears 2nd job, faction, and advanced skills |
| `//job2 <0\|1\|2>` | Set 2nd job path: `1` Order, `2` Chaos. `0` clears 2nd job and faction |
| `//faction <0\|1\|2>` | Set faction (`1` Order, `2` Chaos) and matching 2nd-job title. `0` clears |
| `//skills` | Unlock all skills for current job / path / faction |
| `//maxskills` | Set all owned skills to max level |
| `//item <itemId> [qty]` | Add item to inventory (default item `8810011`, qty `1`) |
| `//ban <playerName>` | Disconnect an online player |

**Job paths** (after `//job 1|2|3`):

| 1st job | Order (`//job2 1`) | Chaos (`//job2 2`) |
|---------|--------------------|--------------------|
| Warrior (`1`) | Knight | Dark Knight |
| Assassin (`2`) | Ninja | Killer |
| Mage (`3`) | White Mage | Black Mage |

## Configuration

| Item | Details |
|------|---------|
| `.env` | Copy from `.env.example`. Required: `DATABASE_URL`. |
| `rates.json` | Rates + optional `.env` overrides. |
| `data/map_pexels/` | Map collision / height |
| `data/client/table/item.itm` | Item ID validation |
| `data/client/data/OBJ/PET/` | Pet sprite checks |
| `data/client/data/Project/` | Map existence checks |

## Project layout

```
src/                 # login / channel / field / messenger
database/schema.sql  # single MySQL schema + all game seed data
data/                # map_pexels + minimal client assets
rates.json
.env.example
```

## Notes

- Unknown usernames auto-register on login.
- `data/client/` holds proprietary game assets required for server-side validation. Redistribute only if you have the rights to do so.
- Existing databases imported before the cash shop cleanup should run `database/migrations/002_prune_incompatible_cash_shop.sql` once.
