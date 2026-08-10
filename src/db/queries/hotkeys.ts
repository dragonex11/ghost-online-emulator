export const DELETE_SKILL_HOTKEYS_BY_CHARID_AND_KEYNAME = `DELETE FROM skill_hotkeys WHERE charid=? AND keyname=?`;

export const INSERT_SKILL_HOTKEYS = `INSERT INTO skill_hotkeys (charid, keyname, skillid, stype, sslot) VALUES (?,?,?,?,?)`;

export const SELECT_SKILL_HOTKEYS_BY_CHARID = `SELECT keyname, skillid, stype, sslot FROM skill_hotkeys WHERE charid=?`;
