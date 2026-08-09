# Game data

## Committed / required at runtime

| Path | Purpose |
|------|---------|
| `map_pexels/` | Map collision / height grids (`.pex`) |
| `client/table/item.itm` | Item ID validation for cash shop |
| `client/data/OBJ/PET/` | Pet sprite IDs |
| `client/data/Project/` | Map existence checks (`.prj`) |

Runtime file `channel_online.txt` may be written here (gitignored).

## Gitignored (not needed to run)

Source dumps already imported into `database/schema.sql`, plus optional rebuild inputs:

- `monster_drops.txt`, `item_prices.txt`, `cashshop*`, `cash_commodities.json`, `monster_spawns_extracted.json`
- `generated/`
- `client/data/Map/` (only for regenerating pexels locally)
